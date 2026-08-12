import { afterEach, describe, expect, test } from "bun:test";
import { createSupervisor } from "../src/supervisor.ts";
import { McpTestClient } from "./support/mcp-client.ts";
import { TestRepository } from "./support/repository.ts";
import { ScriptedAppServer } from "./support/scripted-app-server.ts";

const testRepository = new TestRepository();

afterEach(async () => {
  await testRepository.cleanup();
});

describe("Notification delivery", () => {
  test("accepts immediately, Handles once in a fresh turn, and persists the outcome", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const appServer = new ScriptedAppServer();
    appServer.holdHandlings();
    const generatedValues = [
      "run-1",
      "writer-id",
      "writer-secret",
      "adviser-id",
      "adviser-secret",
      "message-1",
      "conversation-1",
    ];
    const supervisor = createSupervisor({
      appServer,
      generateOpaqueValue: () => generatedValues.shift() ?? "unexpected",
    });
    const started = await supervisor.start({ cwd, configurationPath });
    if (started.status !== "running") {
      throw new Error("Expected Mesh startup to succeed.");
    }
    const launch = appServer.threadRequests()[0]?.mcpServer;
    if (!launch) {
      throw new Error("Expected Writer MCP launch configuration.");
    }
    const writer = McpTestClient.spawn(launch);
    await writer.initialize();

    const sent = await writer.request("tools/call", {
      name: "agents.send",
      arguments: {
        agent_id: "adviser-id",
        body: "Please inspect the public interface.",
        context: {
          subject: "Interface review",
          file_references: ["src/supervisor.ts"],
          git_commit_id: "abc123",
          worktree_fingerprint: "tree-1",
        },
      },
    });

    expect(structuredContent(sent)).toEqual({ message_id: "message-1" });
    const accepted = await supervisor.inspectConversation({
      cwd,
      conversationId: "conversation-1",
    });
    expect(accepted?.message).toEqual({
      id: "message-1",
      kind: "notification",
      senderAgentId: "writer-id",
      recipientAgentId: "adviser-id",
      conversationId: "conversation-1",
      createdAt: expect.any(String),
      body: "Please inspect the public interface.",
      subject: "Interface review",
      fileReferences: ["src/supervisor.ts"],
      gitCommitId: "abc123",
      worktreeFingerprint: "tree-1",
    });
    expect(accepted?.delivery.status).toMatch(/accepted|injecting|injected/);
    if (!accepted) {
      throw new Error("Expected accepted Conversation state.");
    }

    await waitFor(() => appServer.handlingRequests().length === 1);
    expect(appServer.handlingRequests()).toEqual([
      {
        threadId: "thread-adviser",
        message: accepted.message,
      },
    ]);
    appServer.completeHandling("Reviewed without sending a Reply.");
    await waitForConversationCompletion(supervisor, cwd, "conversation-1");

    const completed = await supervisor.inspectConversation({
      cwd,
      conversationId: "conversation-1",
    });
    expect(completed?.status).toBe("completed");
    expect(completed?.delivery).toEqual({
      messageId: "message-1",
      status: "injected",
      codexTurnId: "turn-handling-1",
    });
    expect(completed?.handling).toEqual({
      messageId: "message-1",
      status: "completed",
      codexTurnId: "turn-handling-1",
      finalOutput: "Reviewed without sending a Reply.",
    });
    expect(completed?.events.map((event) => event.type)).toEqual([
      "message.accepted",
      "delivery.injecting",
      "delivery.injected",
      "handling.active",
      "handling.completed",
      "conversation.completed",
    ]);
    expect(completed?.message.kind).toBe("notification");

    await writer.close();
    await supervisor.stop({ meshRunId: started.meshRun.id });
    const retained = await createSupervisor().inspectConversation({
      cwd,
      conversationId: "conversation-1",
    });
    expect(retained).toEqual(completed);
  });

  for (const failure of ["handling-start", "handling-completion"] as const) {
    test(`records terminal state and preserves coherent Agent state after ${failure} failure`, async () => {
      const cwd = await testRepository.gitRepository();
      const configurationPath = await testRepository.writeConfiguration(cwd);
      const appServer = new ScriptedAppServer(failure);
      const generatedValues = [
        "run-1",
        "writer-id",
        "writer-secret",
        "adviser-id",
        "adviser-secret",
        "message-1",
        "conversation-1",
      ];
      const supervisor = createSupervisor({
        appServer,
        generateOpaqueValue: () => generatedValues.shift() ?? "unexpected",
      });
      const started = await supervisor.start({ cwd, configurationPath });
      if (started.status !== "running") {
        throw new Error("Expected Mesh startup to succeed.");
      }
      const launch = appServer.threadRequests()[0]?.mcpServer;
      if (!launch) {
        throw new Error("Expected Writer MCP launch configuration.");
      }
      const writer = McpTestClient.spawn(launch);
      await writer.initialize();

      const sent = await writer.request("tools/call", {
        name: "agents.send",
        arguments: { agent_id: "adviser-id", body: "Inspect this failure path." },
      });
      expect(structuredContent(sent)).toEqual({ message_id: "message-1" });
      await waitFor(async () => {
        const conversation = await supervisor.inspectConversation({
          cwd,
          conversationId: "conversation-1",
        });
        return conversation?.status === "failed";
      });

      const failed = await supervisor.inspectConversation({
        cwd,
        conversationId: "conversation-1",
      });
      if (failure === "handling-start") {
        expect(failed?.delivery.status).toBe("ambiguous");
        expect(failed?.handling).toBeUndefined();
      } else {
        expect(failed?.delivery.status).toBe("injected");
        expect(failed?.handling?.status).toBe("failed");
      }
      const run = await supervisor.inspectMeshRun({ cwd, meshRunId: started.meshRun.id });
      expect(run?.agents.find((agent) => agent.id === "adviser-id")?.status).toBe(
        failure === "handling-start" ? "working" : "idle",
      );

      await writer.close();
      await supervisor.stop({ meshRunId: started.meshRun.id });
    });
  }

  test("rejects invalid Notification bounds and Repository traversal", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const appServer = new ScriptedAppServer();
    const supervisor = createSupervisor({ appServer });
    const started = await supervisor.start({ cwd, configurationPath });
    if (started.status !== "running") {
      throw new Error("Expected Mesh startup to succeed.");
    }
    const launch = appServer.threadRequests()[0]?.mcpServer;
    const adviser = started.meshRun.agents.find((agent) => agent.role === "adviser");
    if (!launch || !adviser) {
      throw new Error("Expected Writer MCP launch and Adviser registration.");
    }
    const writer = McpTestClient.spawn(launch);
    await writer.initialize();

    const oversized = await writer.request("tools/call", {
      name: "agents.send",
      arguments: { agent_id: adviser.id, body: "x".repeat(32 * 1024 + 1) },
    });
    expect(oversized.error?.code).toBe(-32000);
    const traversal = await writer.request("tools/call", {
      name: "agents.send",
      arguments: {
        agent_id: adviser.id,
        body: "Invalid context.",
        context: { file_references: ["../secret"] },
      },
    });
    expect(traversal.error?.code).toBe(-32000);
    const malformed = await writer.request("tools/call", {
      name: "agents.send",
      arguments: {
        agent_id: adviser.id,
        body: "Invalid context.",
        context: { file_references: [42] },
      },
    });
    expect(malformed.error?.code).toBe(-32602);

    await writer.close();
    await supervisor.stop({ meshRunId: started.meshRun.id });
  });
});

function structuredContent(response: {
  result?: unknown;
  error?: { code: number; message: string };
}): unknown {
  if (response.error) {
    throw new Error(`MCP call failed: ${response.error.message}`);
  }
  const result = response.result as { structuredContent?: { result?: unknown } } | undefined;
  return result?.structuredContent?.result;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for asynchronous Notification delivery.");
}

async function waitForConversationCompletion(
  supervisor: ReturnType<typeof createSupervisor>,
  cwd: string,
  conversationId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const conversation = await supervisor.inspectConversation({ cwd, conversationId });
    if (conversation?.status === "completed") {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for Conversation completion.");
}
