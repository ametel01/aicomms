import { afterEach, describe, expect, test } from "bun:test";
import { createSupervisor } from "../src/supervisor.ts";
import { McpTestClient } from "./support/mcp-client.ts";
import { TestRepository } from "./support/repository.ts";
import { ScriptedAppServer, type ScriptedFailure } from "./support/scripted-app-server.ts";

const testRepository = new TestRepository();

afterEach(async () => {
  await testRepository.cleanup();
});

describe("at-most-once Delivery", () => {
  for (const [failure, expectedStatus] of [
    ["handling-rejected", "rejected"],
    ["handling-disconnect", "ambiguous"],
    ["handling-timeout", "ambiguous"],
    ["handling-start", "ambiguous"],
  ] as const) {
    test(`records ${failure} without retrying the Message`, async () => {
      const harness = await startHarness(failure);
      const sent = await send(harness.client, harness.adviserId, `trigger ${failure}`);
      const messageId = content(sent).message_id;

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
      expect(failed?.delivery.status).toBe(expectedStatus);
      expect(
        harness.appServer.handlingRequests().filter((request) => request.message.id === messageId),
      ).toHaveLength(1);

      await harness.client.close();
      await harness.supervisor.stop({ meshRunId: harness.meshRunId });
    });
  }

  test("an intentional retry creates a distinct Message identity", async () => {
    const harness = await startHarness("handling-rejected");

    const first = content(await send(harness.client, harness.adviserId, "retryable"));
    const second = content(await send(harness.client, harness.adviserId, "retryable"));

    expect(first.message_id).not.toBe(second.message_id);
    await waitFor(() => harness.appServer.handlingRequests().length === 2);
    expect(
      new Set(harness.appServer.handlingRequests().map(({ message }) => message.id)).size,
    ).toBe(2);

    await harness.client.close();
    await harness.supervisor.stop({ meshRunId: harness.meshRunId });
  });

  test("rejects excess per-Agent work before accepting it", async () => {
    const harness = await startHarness();
    harness.appServer.holdHandlings();
    const responses = await harness.client.requestBatch(
      Array.from({ length: 34 }, (_, index) => ({
        method: "tools/call",
        params: {
          name: "agents.send",
          arguments: { agent_id: harness.adviserId, body: `burst-${index}` },
        },
      })),
    );

    expect(responses.slice(0, 33).every((response) => response.error === undefined)).toBe(true);
    expect(responses[33]?.error).toEqual({
      code: -32000,
      message: "Recipient Agent queue limit of 32 Messages has been reached.",
    });
    await waitFor(() => harness.appServer.handlingRequests().length === 1);
    expect(harness.appServer.handlingRequests()).toHaveLength(1);

    harness.appServer.completeHandling();
    await harness.client.close();
    await harness.supervisor.stop({ meshRunId: harness.meshRunId });
  });
});

async function startHarness(failure?: ScriptedFailure): Promise<{
  cwd: string;
  adviserId: string;
  meshRunId: string;
  appServer: ScriptedAppServer;
  client: McpTestClient;
  supervisor: ReturnType<typeof createSupervisor>;
}> {
  const cwd = await testRepository.gitRepository();
  const configurationPath = await testRepository.writeConfiguration(cwd);
  const appServer = new ScriptedAppServer(failure);
  let generated = 0;
  const supervisor = createSupervisor({
    appServer,
    generateOpaqueValue: () => {
      generated += 1;
      return generated === 1
        ? "run-1"
        : generated === 2
          ? "writer-id"
          : generated === 3
            ? "writer-secret"
            : generated === 4
              ? "adviser-id"
              : generated === 5
                ? "adviser-secret"
                : generated % 2 === 0
                  ? `message-${(generated - 4) / 2}`
                  : `conversation-${(generated - 5) / 2}`;
    },
  });
  const started = await supervisor.start({ cwd, configurationPath });
  if (started.status !== "running") {
    throw new Error("Expected Mesh startup to succeed.");
  }
  const launch = appServer.threadRequests()[0]?.mcpServer;
  const adviser = started.meshRun.agents.find((agent) => agent.role === "adviser");
  if (!launch || !adviser) {
    throw new Error("Expected Writer MCP launch and Adviser registration.");
  }
  const client = McpTestClient.spawn(launch);
  await client.initialize();
  return {
    cwd,
    adviserId: adviser.id,
    meshRunId: started.meshRun.id,
    appServer,
    client,
    supervisor,
  };
}

async function send(client: McpTestClient, agentId: string, body: string) {
  return client.request("tools/call", {
    name: "agents.send",
    arguments: { agent_id: agentId, body },
  });
}

function content(response: { result?: unknown; error?: { code: number; message: string } }): {
  message_id: string;
} {
  if (response.error) {
    throw new Error(response.error.message);
  }
  const result = response.result as {
    structuredContent?: { result?: { message_id?: unknown } };
  };
  const messageId = result.structuredContent?.result?.message_id;
  if (typeof messageId !== "string") {
    throw new Error("Expected Message ID.");
  }
  return { message_id: messageId };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for Delivery state.");
}
