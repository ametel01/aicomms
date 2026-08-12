import { afterEach, describe, expect, test } from "bun:test";
import type { McpServerLaunch } from "../src/app-server.ts";
import { createSupervisor, type SupervisorOptions } from "../src/supervisor.ts";
import { McpTestClient } from "./support/mcp-client.ts";
import { TestRepository } from "./support/repository.ts";
import { ScriptedAppServer } from "./support/scripted-app-server.ts";

const testRepository = new TestRepository();

afterEach(async () => {
  await testRepository.cleanup();
});

describe("causal Conversation limits", () => {
  test("allows new Conversations only from the Writer's initial Objective", async () => {
    const harness = await startHarness();
    const adviser = await mcpClient(harness.adviserLaunch);
    const unauthorizedAdviser = await send(adviser, "writer-id", "Idle Adviser root Message");
    expect(unauthorizedAdviser.error?.code).toBe(-32000);

    harness.appServer.emitThreadStatus("thread-writer", "idle");
    const lateWriter = await send(harness.writer, "adviser-id", "Post-Objective root Message");
    expect(lateWriter.error?.code).toBe(-32000);
    expect(harness.appServer.handlingRequests()).toEqual([]);

    await adviser.close();
    await harness.close();
  });

  test("rejects duplicate Message IDs and repeated causal Message hashes", async () => {
    const harness = await startHarness({
      generated: [
        "run-1",
        "writer-id",
        "writer-secret",
        "adviser-id",
        "adviser-secret",
        "message-1",
        "conversation-1",
        "message-1",
        "conversation-2",
        "message-2",
        "message-3",
      ],
    });
    harness.appServer.holdHandlings();
    expect((await ask(harness.writer, "adviser-id", "Root Question")).error).toBeUndefined();
    await waitFor(() => harness.appServer.handlingRequests().length === 1);

    const duplicateId = await send(harness.writer, "adviser-id", "Different root body");
    expect(duplicateId.error).toEqual({
      code: -32000,
      message: "Duplicate Message ID was rejected.",
    });
    const adviser = await mcpClient(harness.adviserLaunch);
    expect((await send(adviser, "writer-id", "Same causal body")).error).toBeUndefined();
    const repeatedHash = await send(adviser, "writer-id", "Same causal body");
    expect(repeatedHash.error).toEqual({
      code: -32000,
      message: "Repeated sender-recipient-body Message was rejected.",
    });
    const conversation = await harness.supervisor.inspectConversation({
      cwd: harness.cwd,
      conversationId: "conversation-1",
    });
    expect(conversation?.messages.map(({ id }) => id)).toEqual(["message-1", "message-2"]);
    expect(
      await harness.supervisor.inspectConversation({
        cwd: harness.cwd,
        conversationId: "conversation-2",
      }),
    ).toBeUndefined();

    await adviser.close();
    await harness.close();
  });

  test("stops a Conversation at four Agent-triggering Messages", async () => {
    const harness = await startHarness();
    harness.appServer.holdHandlings();
    await ask(harness.writer, "adviser-id", "Root Question");
    await waitFor(() => harness.appServer.handlingRequests().length === 1);
    const adviser = await mcpClient(harness.adviserLaunch);
    for (const body of ["nested-1", "nested-2", "nested-3"]) {
      expect((await send(adviser, "writer-id", body)).error).toBeUndefined();
    }
    const excess = await send(adviser, "writer-id", "nested-4");
    expect(excess.error).toEqual({
      code: -32000,
      message: "Conversation Agent-triggering Message limit of 4 has been reached.",
    });

    const limited = await harness.supervisor.inspectConversation({
      cwd: harness.cwd,
      conversationId: "conversation-1",
    });
    expect(limited?.status).toBe("limit_reached");
    expect(limited?.messages).toHaveLength(4);
    expect(limited?.deliveries.slice(1).map(({ status }) => status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(limited?.events.map(({ type }) => type)).toContain("conversation.limit_reached");

    const unrelated = await harness.writer.requestBatch(
      Array.from({ length: 32 }, (_, index) => ({
        method: "tools/call",
        params: {
          name: "agents.send",
          arguments: { agent_id: "writer-id", body: `unrelated-${index}` },
        },
      })),
    );
    expect(unrelated.every((response) => response.error === undefined)).toBe(true);

    await adviser.close();
    await harness.close();
  });

  test("applies the total Message limit to automatic Replies", async () => {
    const harness = await startHarness({
      supervisorOptions: {
        conversationLimits: { agentTriggeredMessages: 4, totalMessages: 2 },
      },
    });
    harness.appServer.holdHandlings();
    await ask(harness.writer, "adviser-id", "Root Question");
    await waitFor(() => harness.appServer.handlingRequests().length === 1);
    const adviser = await mcpClient(harness.adviserLaunch);
    await send(adviser, "writer-id", "Second total Message");

    harness.appServer.completeHandling("Reply would be the third Message");
    await waitFor(async () => {
      const conversation = await harness.supervisor.inspectConversation({
        cwd: harness.cwd,
        conversationId: "conversation-1",
      });
      return conversation?.status === "limit_reached";
    });
    const limited = await harness.supervisor.inspectConversation({
      cwd: harness.cwd,
      conversationId: "conversation-1",
    });
    expect(limited?.messages).toHaveLength(2);
    expect(limited?.messages.some(({ kind }) => kind === "reply")).toBe(false);
    expect(limited?.handlings[0]?.status).toBe("completed");

    await adviser.close();
    await harness.close();
  });

  test("expires after five minutes and records late output without reactivation", async () => {
    let now = 0;
    let deadline: (() => void) | undefined;
    let scheduledDelay: number | undefined;
    const harness = await startHarness({
      supervisorOptions: {
        now: () => now,
        scheduleDeadline: (callback, delayMilliseconds) => {
          deadline = callback;
          scheduledDelay = delayMilliseconds;
          return () => {};
        },
      },
    });
    harness.appServer.holdHandlings();
    await ask(harness.writer, "adviser-id", "Root Question");
    await waitFor(() => harness.appServer.handlingRequests().length === 1);
    const adviser = await mcpClient(harness.adviserLaunch);
    await send(adviser, "writer-id", "Queued causal sibling");
    expect(scheduledDelay).toBe(5 * 60 * 1000);

    now = 5 * 60 * 1000;
    deadline?.();
    const expired = await harness.supervisor.inspectConversation({
      cwd: harness.cwd,
      conversationId: "conversation-1",
    });
    expect(expired?.status).toBe("expired");
    expect(expired?.deliveries[1]?.status).toBe("expired");

    harness.appServer.completeHandling("Late Reply output");
    await waitFor(async () => {
      const conversation = await harness.supervisor.inspectConversation({
        cwd: harness.cwd,
        conversationId: "conversation-1",
      });
      return conversation?.handlings[0]?.status === "completed";
    });
    const retained = await harness.supervisor.inspectConversation({
      cwd: harness.cwd,
      conversationId: "conversation-1",
    });
    expect(retained?.status).toBe("expired");
    expect(retained?.messages).toHaveLength(2);
    expect(retained?.messages.some(({ kind }) => kind === "reply")).toBe(false);
    expect(retained?.handlings[0]?.finalOutput).toBe("Late Reply output");
    expect(retained?.events.map(({ type }) => type)).toContain("conversation.expired");

    await adviser.close();
    await harness.close();
  });
});

async function startHarness(
  options: {
    generated?: string[];
    supervisorOptions?: Omit<SupervisorOptions, "appServer" | "generateOpaqueValue">;
  } = {},
): Promise<{
  cwd: string;
  writer: McpTestClient;
  adviserLaunch: McpServerLaunch;
  appServer: ScriptedAppServer;
  supervisor: ReturnType<typeof createSupervisor>;
  close(): Promise<void>;
}> {
  const cwd = await testRepository.gitRepository();
  const configurationPath = await testRepository.writeConfiguration(cwd);
  const appServer = new ScriptedAppServer();
  let fallbackId = 0;
  const generated = options.generated ?? [
    "run-1",
    "writer-id",
    "writer-secret",
    "adviser-id",
    "adviser-secret",
  ];
  const supervisor = createSupervisor({
    ...options.supervisorOptions,
    appServer,
    generateOpaqueValue: () => {
      const preset = generated.shift();
      if (preset) {
        return preset;
      }
      fallbackId += 1;
      return fallbackId % 2 === 1
        ? `message-${(fallbackId + 1) / 2}`
        : `conversation-${fallbackId / 2}`;
    },
  });
  const started = await supervisor.start({ cwd, configurationPath });
  if (started.status !== "running") {
    throw new Error("Expected Mesh startup to succeed.");
  }
  const writerLaunch = appServer.threadRequests()[0]?.mcpServer;
  const adviserLaunch = appServer.threadRequests()[1]?.mcpServer;
  if (!writerLaunch || !adviserLaunch) {
    throw new Error("Expected two MCP launches.");
  }
  const writer = await mcpClient(writerLaunch);
  return {
    cwd,
    writer,
    adviserLaunch,
    appServer,
    supervisor,
    async close() {
      await writer.close();
      await supervisor.stop({ meshRunId: started.meshRun.id });
    },
  };
}

async function mcpClient(launch: McpServerLaunch): Promise<McpTestClient> {
  const client = McpTestClient.spawn(launch);
  await client.initialize();
  return client;
}

function send(client: McpTestClient, agentId: string, body: string) {
  return client.request("tools/call", {
    name: "agents.send",
    arguments: { agent_id: agentId, body },
  });
}

function ask(client: McpTestClient, agentId: string, body: string) {
  return client.request("tools/call", {
    name: "agents.ask",
    arguments: { agent_id: agentId, body },
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for causal Conversation state.");
}
