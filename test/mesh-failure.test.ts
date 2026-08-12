import { afterEach, describe, expect, test } from "bun:test";
import { type PublicAgent, resolveRepositoryIdentity } from "../src/startup-validation.ts";
import { createSupervisor } from "../src/supervisor.ts";
import { type ConversationLimits, type Message, TranscriptStore } from "../src/transcript-store.ts";
import { McpTestClient } from "./support/mcp-client.ts";
import { TestRepository } from "./support/repository.ts";
import { ScriptedAppServer } from "./support/scripted-app-server.ts";

const testRepository = new TestRepository();
const limits: ConversationLimits = {
  agentTriggeredMessages: 4,
  totalMessages: 8,
  elapsedMilliseconds: 5 * 60 * 1000,
};

afterEach(async () => {
  await testRepository.cleanup();
});

describe("Mesh failure without replay", () => {
  test("does not miss an app-server exit during thread startup", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const appServer = new ScriptedAppServer();
    appServer.exitOnNextThreadStart("exited while starting a thread");
    const generated = [
      "startup-exit-run",
      "startup-exit-writer",
      "startup-exit-writer-secret",
      "startup-exit-adviser",
      "startup-exit-adviser-secret",
    ];
    const supervisor = createSupervisor({
      appServer,
      generateOpaqueValue: () => generated.shift() ?? "unexpected-generated-value",
    });

    const started = await supervisor.start({ cwd, configurationPath });

    expect(started).toEqual({
      status: "failed",
      meshRunId: "startup-exit-run",
      error: {
        code: "startup.prerequisite_failed",
        message: "app_server_lost: exited while starting a thread",
      },
    });
    expect(await supervisor.inspectMeshRun({ cwd, meshRunId: "startup-exit-run" })).toEqual(
      expect.objectContaining({
        status: "failed",
        failureMessage: "app_server_lost: exited while starting a thread",
      }),
    );
    expect(appServer.calls.map(({ operation }) => operation)).not.toContain("start-objective");
  });

  test("fails an unexpected app-server exit and preserves ambiguous in-flight evidence", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const appServer = new ScriptedAppServer();
    appServer.holdHandlingStarts();
    const generated = [
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
      generateOpaqueValue: () => generated.shift() ?? "unexpected-generated-value",
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
    await writer.request("tools/call", {
      name: "agents.ask",
      arguments: { agent_id: "adviser-id", body: "Inspect the failure path" },
    });
    await waitFor(() => appServer.handlingRequests().length === 1);

    appServer.emitUnexpectedExit("transport exited with code 9");

    const failedRun = await supervisor.inspectMeshRun({ cwd, meshRunId: "run-1" });
    const failedConversation = await supervisor.inspectConversation({
      cwd,
      conversationId: "conversation-1",
    });
    expect(failedRun).toEqual(
      expect.objectContaining({
        id: "run-1",
        status: "failed",
        failureMessage: "app_server_lost: transport exited with code 9",
        agents: [
          expect.objectContaining({ id: "writer-id", status: "stopped" }),
          expect.objectContaining({ id: "adviser-id", status: "stopped" }),
        ],
      }),
    );
    expect(failedConversation).toEqual(
      expect.objectContaining({
        status: "failed",
        delivery: expect.objectContaining({
          status: "ambiguous",
          failureMessage: "app_server_lost: transport exited with code 9",
        }),
        notices: expect.arrayContaining([
          expect.objectContaining({ recipientAgentId: "writer-id" }),
          expect.objectContaining({ recipientAgentId: "adviser-id" }),
        ]),
      }),
    );
    expect(appServer.calls.map(({ operation }) => operation)).not.toContain("close");

    appServer.releaseHandlingStart();
    await writer.close();
  });

  test("fails stale nonterminal evidence before creating fresh Agent and thread identities", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const repository = await resolveRepositoryIdentity(cwd);
    if (!repository) {
      throw new Error("Expected Repository identity.");
    }
    const oldAgents: PublicAgent[] = [
      {
        id: "old-writer",
        name: "writer",
        role: "writer",
        objective: "Old objective",
        capabilities: ["code"],
        threadId: "old-thread-writer",
        status: "working",
      },
      {
        id: "old-adviser",
        name: "adviser",
        role: "adviser",
        objective: "Old advice",
        capabilities: ["review"],
        threadId: "old-thread-adviser",
        status: "idle",
      },
    ];
    const oldMessage: Message = {
      id: "old-message",
      kind: "question",
      senderAgentId: "old-writer",
      recipientAgentId: "old-adviser",
      conversationId: "old-conversation",
      createdAt: new Date(0).toISOString(),
      body: "Old uncertain work",
    };
    const store = await TranscriptStore.open(cwd);
    store.createMeshRun({
      id: "old-run",
      repositoryId: repository.id,
      status: "starting",
      agents: oldAgents,
    });
    store.markRunning("old-run", oldAgents);
    expect(store.recordAgentMessage("old-run", oldMessage, true, limits, 0).accepted).toBe(true);
    expect(store.markDeliveryInjecting(oldMessage)).toBe(true);
    store.close();

    const appServer = new ScriptedAppServer();
    const generated = [
      "new-run",
      "new-writer",
      "new-writer-secret",
      "new-adviser",
      "new-adviser-secret",
    ];
    const supervisor = createSupervisor({
      appServer,
      generateOpaqueValue: () => generated.shift() ?? "unexpected-generated-value",
    });
    const started = await supervisor.start({ cwd, configurationPath });
    if (started.status !== "running") {
      throw new Error("Expected replacement Mesh startup to succeed.");
    }

    const staleRun = await supervisor.inspectMeshRun({ cwd, meshRunId: "old-run" });
    const staleConversation = await supervisor.inspectConversation({
      cwd,
      conversationId: "old-conversation",
    });
    expect(staleRun).toEqual(
      expect.objectContaining({ status: "failed", failureMessage: "supervisor_lost" }),
    );
    expect(staleConversation).toEqual(
      expect.objectContaining({
        status: "failed",
        delivery: expect.objectContaining({
          status: "ambiguous",
          failureMessage: "supervisor_lost",
        }),
        notices: expect.arrayContaining([
          expect.objectContaining({ recipientAgentId: "old-writer", reason: "supervisor_lost" }),
          expect.objectContaining({ recipientAgentId: "old-adviser", reason: "supervisor_lost" }),
        ]),
      }),
    );
    expect(started.meshRun.id).toBe("new-run");
    expect(started.meshRun.agents.map(({ id }) => id)).toEqual(["new-writer", "new-adviser"]);
    expect(appServer.threadRequests().map(({ agentId }) => agentId)).toEqual([
      "new-writer",
      "new-adviser",
    ]);
    expect(appServer.handlingRequests()).toEqual([]);

    await supervisor.stop({ meshRunId: "new-run" });
  });
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for Mesh failure state.");
}
