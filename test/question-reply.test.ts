import { afterEach, describe, expect, test } from "bun:test";
import { createSupervisor } from "../src/supervisor.ts";
import { McpTestClient } from "./support/mcp-client.ts";
import { TestRepository } from "./support/repository.ts";
import { ScriptedAppServer } from "./support/scripted-app-server.ts";

const testRepository = new TestRepository();

afterEach(async () => {
  await testRepository.cleanup();
});

describe("asynchronous Question and Reply", () => {
  test("turns final output into one correlated Reply and Handles it in a fresh turn", async () => {
    const harness = await startHarness();
    harness.appServer.holdHandlings();

    const asked = await harness.writer.request("tools/call", {
      name: "agents.ask",
      arguments: { agent_id: "adviser-id", body: "What should change?" },
    });
    expect(content(asked)).toEqual({ message_id: "question-1" });
    await waitFor(() => harness.appServer.handlingRequests().length === 1);
    expect(harness.appServer.handlingRequests()[0]?.message.kind).toBe("question");

    harness.appServer.completeHandling("Use one bounded interface.");
    await waitFor(async () => {
      const conversation = await harness.supervisor.inspectConversation({
        cwd: harness.cwd,
        conversationId: "conversation-1",
      });
      return conversation?.messages.length === 2;
    });
    const waiting = await harness.supervisor.inspectConversation({
      cwd: harness.cwd,
      conversationId: "conversation-1",
    });
    expect(waiting?.messages[1]).toEqual({
      id: "reply-1",
      kind: "reply",
      senderAgentId: "adviser-id",
      recipientAgentId: "writer-id",
      conversationId: "conversation-1",
      createdAt: expect.any(String),
      body: "Use one bounded interface.",
      inReplyTo: "question-1",
    });
    expect(waiting?.status).toBe("open");
    expect(waiting?.deliveries[1]?.status).toBe("queued");

    harness.appServer.emitThreadStatus("thread-writer", "idle");
    await waitFor(() => harness.appServer.handlingRequests().length === 2);
    await waitFor(async () => {
      const conversation = await harness.supervisor.inspectConversation({
        cwd: harness.cwd,
        conversationId: "conversation-1",
      });
      return conversation?.status === "completed";
    });
    const completed = await harness.supervisor.inspectConversation({
      cwd: harness.cwd,
      conversationId: "conversation-1",
    });
    expect(completed?.messages).toHaveLength(2);
    expect(completed?.handlings).toHaveLength(2);
    expect(completed?.notices).toEqual([]);
    expect(harness.appServer.handlingRequests()[1]?.message.kind).toBe("reply");

    await harness.writer.close();
    await harness.supervisor.stop({ meshRunId: harness.meshRunId });
  });

  test("fails an unanswered Question and creates a Supervisor Notice without a Reply", async () => {
    const harness = await startHarness();
    harness.appServer.holdHandlings();
    await harness.writer.request("tools/call", {
      name: "agents.ask",
      arguments: { agent_id: "adviser-id", body: "Can you answer?" },
    });
    await waitFor(() => harness.appServer.handlingRequests().length === 1);

    harness.appServer.completeHandling();
    await waitFor(async () => {
      const conversation = await harness.supervisor.inspectConversation({
        cwd: harness.cwd,
        conversationId: "conversation-1",
      });
      return conversation?.status === "failed";
    });
    const failed = await harness.supervisor.inspectConversation({
      cwd: harness.cwd,
      conversationId: "conversation-1",
    });
    expect(failed?.messages).toHaveLength(1);
    expect(failed?.messages[0]?.kind).toBe("question");
    expect(failed?.notices).toEqual([
      expect.objectContaining({
        recipientAgentId: "writer-id",
        conversationId: "conversation-1",
        reason: "Question Handling produced no Reply.",
      }),
    ]);
    harness.appServer.emitThreadStatus("thread-writer", "unloaded");
    await waitFor(() => harness.appServer.noticeRequests().length === 1);
    expect(harness.appServer.noticeRequests()[0]?.notice.reason).toBe(
      "Question Handling produced no Reply.",
    );
    const noticeOperations = harness.appServer.calls
      .filter((call) => call.operation === "resume-thread" || call.operation === "start-notice")
      .map((call) => call.operation);
    expect(noticeOperations).toEqual(["resume-thread", "start-notice"]);

    await harness.writer.close();
    await harness.supervisor.stop({ meshRunId: harness.meshRunId });
  });

  test("delivers Reply Handling failures to the asker as Supervisor Notices", async () => {
    const harness = await startHarness();
    harness.appServer.holdHandlings();
    await harness.writer.request("tools/call", {
      name: "agents.ask",
      arguments: { agent_id: "adviser-id", body: "Answer then fail delivery." },
    });
    await waitFor(() => harness.appServer.handlingRequests().length === 1);
    harness.appServer.failNextHandling("handling-rejected");
    harness.appServer.completeHandling("A valid Reply.");
    harness.appServer.emitThreadStatus("thread-writer", "idle");

    await waitFor(async () => {
      const conversation = await harness.supervisor.inspectConversation({
        cwd: harness.cwd,
        conversationId: "conversation-1",
      });
      return conversation?.deliveries[1]?.status === "rejected";
    });
    const failed = await harness.supervisor.inspectConversation({
      cwd: harness.cwd,
      conversationId: "conversation-1",
    });
    expect(failed?.messages).toHaveLength(2);
    expect(failed?.notices).toEqual([
      expect.objectContaining({
        recipientAgentId: "writer-id",
        reason: "scripted definite rejection",
      }),
    ]);
    await waitFor(() => harness.appServer.noticeRequests().length === 1);

    await harness.writer.close();
    await harness.supervisor.stop({ meshRunId: harness.meshRunId });
  });

  test("inherits the active Handling Conversation for nested peer Questions", async () => {
    const harness = await startHarness();
    harness.appServer.holdHandlings();
    await harness.writer.request("tools/call", {
      name: "agents.ask",
      arguments: { agent_id: "adviser-id", body: "Outer Question" },
    });
    await waitFor(() => harness.appServer.handlingRequests().length === 1);
    const adviserLaunch = harness.appServer.threadRequests()[1]?.mcpServer;
    if (!adviserLaunch) {
      throw new Error("Expected Adviser MCP launch.");
    }
    const adviser = McpTestClient.spawn(adviserLaunch);
    await adviser.initialize();

    await adviser.request("tools/call", {
      name: "agents.ask",
      arguments: { agent_id: "writer-id", body: "Nested Question" },
    });
    const inherited = await harness.supervisor.inspectConversation({
      cwd: harness.cwd,
      conversationId: "conversation-1",
    });
    expect(inherited?.messages.map((message) => message.conversationId)).toEqual([
      "conversation-1",
      "conversation-1",
    ]);
    expect(inherited?.messages.map((message) => message.body)).toEqual([
      "Outer Question",
      "Nested Question",
    ]);

    await adviser.close();
    await harness.writer.close();
    await harness.supervisor.stop({ meshRunId: harness.meshRunId });
  });

  test("keeps a causal Conversation open until every sibling Message is handled", async () => {
    const harness = await startHarness();
    harness.appServer.holdHandlings();
    await harness.writer.request("tools/call", {
      name: "agents.ask",
      arguments: { agent_id: "adviser-id", body: "Outer Question" },
    });
    await waitFor(() => harness.appServer.handlingRequests().length === 1);
    const adviserLaunch = harness.appServer.threadRequests()[1]?.mcpServer;
    if (!adviserLaunch) {
      throw new Error("Expected Adviser MCP launch.");
    }
    const adviser = McpTestClient.spawn(adviserLaunch);
    await adviser.initialize();
    await adviser.request("tools/call", {
      name: "agents.send",
      arguments: { agent_id: "writer-id", body: "Nested Notification" },
    });
    harness.appServer.completeHandling("Outer Reply");
    await waitFor(async () => {
      const conversation = await harness.supervisor.inspectConversation({
        cwd: harness.cwd,
        conversationId: "conversation-1",
      });
      return conversation?.messages.length === 3;
    });

    harness.appServer.holdHandlings();
    harness.appServer.emitThreadStatus("thread-writer", "idle");
    await waitFor(() => harness.appServer.handlingRequests().length === 2);
    expect(harness.appServer.handlingRequests()[1]?.message.kind).toBe("notification");
    harness.appServer.completeHandling("Recorded only");
    harness.appServer.holdHandlings();
    await waitFor(() => harness.appServer.handlingRequests().length === 3);
    const betweenSiblings = await harness.supervisor.inspectConversation({
      cwd: harness.cwd,
      conversationId: "conversation-1",
    });
    expect(betweenSiblings?.status).toBe("open");
    expect(betweenSiblings?.deliveries[2]?.status).toBe("injected");
    expect(harness.appServer.handlingRequests()[2]?.message.kind).toBe("reply");

    harness.appServer.completeHandling("Recorded only");
    await waitFor(async () => {
      const conversation = await harness.supervisor.inspectConversation({
        cwd: harness.cwd,
        conversationId: "conversation-1",
      });
      return conversation?.status === "completed";
    });

    await adviser.close();
    await harness.writer.close();
    await harness.supervisor.stop({ meshRunId: harness.meshRunId });
  });

  test("does not inject a queued sibling after its causal Conversation fails", async () => {
    const harness = await startHarness();
    harness.appServer.holdHandlings();
    await harness.writer.request("tools/call", {
      name: "agents.ask",
      arguments: { agent_id: "adviser-id", body: "Outer Question" },
    });
    await waitFor(() => harness.appServer.handlingRequests().length === 1);
    const adviserLaunch = harness.appServer.threadRequests()[1]?.mcpServer;
    if (!adviserLaunch) {
      throw new Error("Expected Adviser MCP launch.");
    }
    const adviser = McpTestClient.spawn(adviserLaunch);
    await adviser.initialize();
    await adviser.request("tools/call", {
      name: "agents.send",
      arguments: { agent_id: "writer-id", body: "Late sibling" },
    });

    harness.appServer.completeHandling();
    await waitFor(async () => {
      const conversation = await harness.supervisor.inspectConversation({
        cwd: harness.cwd,
        conversationId: "conversation-1",
      });
      return conversation?.status === "failed";
    });
    harness.appServer.emitThreadStatus("thread-writer", "idle");
    await waitFor(async () => {
      const conversation = await harness.supervisor.inspectConversation({
        cwd: harness.cwd,
        conversationId: "conversation-1",
      });
      return conversation?.deliveries[1]?.status === "cancelled";
    });
    expect(harness.appServer.handlingRequests()).toHaveLength(1);
    await waitFor(() => harness.appServer.noticeRequests().length === 1);

    await adviser.close();
    await harness.writer.close();
    await harness.supervisor.stop({ meshRunId: harness.meshRunId });
  });
});

async function startHarness(): Promise<{
  cwd: string;
  meshRunId: string;
  writer: McpTestClient;
  appServer: ScriptedAppServer;
  supervisor: ReturnType<typeof createSupervisor>;
}> {
  const cwd = await testRepository.gitRepository();
  const configurationPath = await testRepository.writeConfiguration(cwd);
  const appServer = new ScriptedAppServer();
  const generated = [
    "run-1",
    "writer-id",
    "writer-secret",
    "adviser-id",
    "adviser-secret",
    "question-1",
    "conversation-1",
    "reply-1",
  ];
  const supervisor = createSupervisor({
    appServer,
    generateOpaqueValue: () => generated.shift() ?? "unexpected",
  });
  const started = await supervisor.start({ cwd, configurationPath });
  if (started.status !== "running") {
    throw new Error("Expected Mesh startup to succeed.");
  }
  const launch = appServer.threadRequests()[0]?.mcpServer;
  if (!launch) {
    throw new Error("Expected Writer MCP launch.");
  }
  const writer = McpTestClient.spawn(launch);
  await writer.initialize();
  return { cwd, meshRunId: started.meshRun.id, writer, appServer, supervisor };
}

function content(response: { result?: unknown; error?: { code: number; message: string } }) {
  if (response.error) {
    throw new Error(response.error.message);
  }
  const result = response.result as { structuredContent?: { result?: unknown } };
  return result.structuredContent?.result;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for Question and Reply state.");
}
