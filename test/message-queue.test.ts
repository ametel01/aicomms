import { afterEach, describe, expect, test } from "bun:test";
import { createSupervisor } from "../src/supervisor.ts";
import { McpTestClient } from "./support/mcp-client.ts";
import { TestRepository } from "./support/repository.ts";
import { ScriptedAppServer } from "./support/scripted-app-server.ts";

const testRepository = new TestRepository();

afterEach(async () => {
  await testRepository.cleanup();
});

describe("Message queue", () => {
  test("serializes busy-recipient Messages in FIFO acceptance order", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const appServer = new ScriptedAppServer();
    appServer.holdHandlings();
    const generated = [
      "run",
      "writer",
      "writer-secret",
      "adviser",
      "adviser-secret",
      "message-1",
      "conversation-1",
      "message-2",
      "conversation-2",
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

    await send(writer, "adviser", "first");
    await waitFor(() => appServer.handlingRequests().length === 1);
    await send(writer, "adviser", "second");
    const queued = await supervisor.inspectConversation({ cwd, conversationId: "conversation-2" });
    expect(queued?.delivery.status).toBe("queued");
    expect(appServer.handlingRequests()).toHaveLength(1);

    appServer.completeHandling("done");
    await waitFor(() => appServer.handlingRequests().length === 2);
    expect(appServer.handlingRequests().map((request) => request.message.body)).toEqual([
      "first",
      "second",
    ]);
    await waitFor(async () => {
      const second = await supervisor.inspectConversation({
        cwd,
        conversationId: "conversation-2",
      });
      return second?.status === "completed";
    });
    expect(appServer.calls.map((call): string => call.operation)).not.toContain("steer-turn");
    expect(appServer.calls.map((call): string => call.operation)).not.toContain("interrupt-turn");

    await writer.close();
    await supervisor.stop({ meshRunId: started.meshRun.id });
  });

  test("persists queued state for pipelined Messages accepted in one socket tick", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const appServer = new ScriptedAppServer();
    appServer.holdHandlings();
    const generated = [
      "run",
      "writer",
      "writer-secret",
      "adviser",
      "adviser-secret",
      "message-1",
      "conversation-1",
      "message-2",
      "conversation-2",
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

    await writer.requestBatch([
      {
        method: "tools/call",
        params: {
          name: "agents.send",
          arguments: { agent_id: "adviser", body: "first" },
        },
      },
      {
        method: "tools/call",
        params: {
          name: "agents.send",
          arguments: { agent_id: "adviser", body: "second" },
        },
      },
    ]);

    const second = await supervisor.inspectConversation({
      cwd,
      conversationId: "conversation-2",
    });
    expect(second?.events.map((event) => event.type)).toContain("delivery.queued");
    expect(appServer.handlingRequests()).toHaveLength(1);

    appServer.completeHandling();
    await waitFor(() => appServer.handlingRequests().length === 2);
    await writer.close();
    await supervisor.stop({ meshRunId: started.meshRun.id });
  });

  test("resumes an unloaded thread before starting its queued Handling", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const appServer = new ScriptedAppServer();
    const generated = [
      "run",
      "writer",
      "writer-secret",
      "adviser",
      "adviser-secret",
      "message-1",
      "conversation-1",
      "message-2",
      "conversation-2",
    ];
    const supervisor = createSupervisor({
      appServer,
      generateOpaqueValue: () => generated.shift() ?? "unexpected",
    });
    const started = await supervisor.start({ cwd, configurationPath });
    if (started.status !== "running") {
      throw new Error("Expected Mesh startup to succeed.");
    }
    appServer.emitThreadStatus("thread-adviser", "unloaded");
    const launch = appServer.threadRequests()[0]?.mcpServer;
    if (!launch) {
      throw new Error("Expected Writer MCP launch.");
    }
    const writer = McpTestClient.spawn(launch);
    await writer.initialize();

    await send(writer, "adviser", "resume me");
    await waitFor(() => appServer.handlingRequests().length === 1);
    const relevantCalls = appServer.calls.filter(
      (call) => call.operation === "resume-thread" || call.operation === "start-handling",
    );
    expect(relevantCalls.map((call) => call.operation)).toEqual([
      "resume-thread",
      "start-handling",
    ]);

    await writer.close();
    await supervisor.stop({ meshRunId: started.meshRun.id });
  });

  test("records terminal Delivery when an unloaded thread cannot resume", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const appServer = new ScriptedAppServer("resume-thread");
    const generated = [
      "run",
      "writer",
      "writer-secret",
      "adviser",
      "adviser-secret",
      "message-1",
      "conversation-1",
      "message-2",
      "conversation-2",
    ];
    const supervisor = createSupervisor({
      appServer,
      generateOpaqueValue: () => generated.shift() ?? "unexpected",
    });
    const started = await supervisor.start({ cwd, configurationPath });
    if (started.status !== "running") {
      throw new Error("Expected Mesh startup to succeed.");
    }
    appServer.emitThreadStatus("thread-adviser", "unloaded");
    const launch = appServer.threadRequests()[0]?.mcpServer;
    if (!launch) {
      throw new Error("Expected Writer MCP launch.");
    }
    const writer = McpTestClient.spawn(launch);
    await writer.initialize();

    await writer.requestBatch([
      {
        method: "tools/call",
        params: {
          name: "agents.send",
          arguments: { agent_id: "adviser", body: "cannot resume first" },
        },
      },
      {
        method: "tools/call",
        params: {
          name: "agents.send",
          arguments: { agent_id: "adviser", body: "cannot resume second" },
        },
      },
    ]);
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
    expect(failed?.delivery.status).toBe("ambiguous");
    expect(failed?.delivery.failureMessage).toBe("scripted thread resume failure");
    await waitFor(async () => {
      const second = await supervisor.inspectConversation({
        cwd,
        conversationId: "conversation-2",
      });
      return second?.status === "failed";
    });
    const failedSecond = await supervisor.inspectConversation({
      cwd,
      conversationId: "conversation-2",
    });
    expect(failedSecond?.status).toBe("failed");
    expect(failedSecond?.delivery.status).toBe("ambiguous");
    expect(appServer.handlingRequests()).toHaveLength(0);
    const run = await supervisor.inspectMeshRun({ cwd, meshRunId: started.meshRun.id });
    expect(run?.agents.find((agent) => agent.id === "adviser")?.status).toBe("unloaded");

    await writer.close();
    await supervisor.stop({ meshRunId: started.meshRun.id });
  });

  test("pauses the queue after ambiguous turn acceptance", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const appServer = new ScriptedAppServer("handling-start");
    const generated = [
      "run",
      "writer",
      "writer-secret",
      "adviser",
      "adviser-secret",
      "message-1",
      "conversation-1",
      "message-2",
      "conversation-2",
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

    await writer.requestBatch([
      {
        method: "tools/call",
        params: {
          name: "agents.send",
          arguments: { agent_id: "adviser", body: "ambiguous first" },
        },
      },
      {
        method: "tools/call",
        params: {
          name: "agents.send",
          arguments: { agent_id: "adviser", body: "must wait" },
        },
      },
    ]);
    await waitFor(async () => {
      const first = await supervisor.inspectConversation({
        cwd,
        conversationId: "conversation-1",
      });
      return first?.delivery.status === "ambiguous";
    });
    expect(appServer.handlingRequests()).toHaveLength(1);
    const second = await supervisor.inspectConversation({
      cwd,
      conversationId: "conversation-2",
    });
    expect(second?.delivery.status).toBe("queued");

    await writer.close();
    await supervisor.stop({ meshRunId: started.meshRun.id });
  });
});

async function send(client: McpTestClient, recipientAgentId: string, body: string): Promise<void> {
  const response = await client.request("tools/call", {
    name: "agents.send",
    arguments: { agent_id: recipientAgentId, body },
  });
  if (response.error) {
    throw new Error(response.error.message);
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for queued Message delivery.");
}
