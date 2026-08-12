import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSupervisor } from "../src/supervisor.ts";
import { McpTestClient } from "./support/mcp-client.ts";
import { TestRepository } from "./support/repository.ts";
import { ScriptedAppServer } from "./support/scripted-app-server.ts";

const testRepository = new TestRepository();

afterEach(async () => {
  await testRepository.cleanup();
});

describe("Operator control", () => {
  test("surfaces waits without answering and pauses time until every wait is resolved", async () => {
    let now = 0;
    const deadlines: Array<{
      callback: () => void;
      delay: number;
      cancelled: boolean;
    }> = [];
    const harness = await startHarness({
      now: () => now,
      scheduleDeadline: (callback, delay) => {
        const scheduled = { callback, delay, cancelled: false };
        deadlines.push(scheduled);
        return () => {
          scheduled.cancelled = true;
        };
      },
    });
    expect(JSON.stringify(harness.appServer.threadRequests())).not.toContain(
      harness.operatorCredential,
    );
    harness.appServer.holdHandlings();
    await ask(harness.writer, "adviser-id", "Needs Operator decisions");
    await waitFor(() => harness.appServer.handlingRequests().length === 1);

    now = 2 * 60 * 1000;
    harness.appServer.emitOperatorWait({
      id: "approval-1",
      type: "approval",
      threadId: "thread-adviser",
      turnId: "turn-handling-1",
      prompt: "Allow the bounded command?",
    });
    harness.appServer.emitOperatorWait({
      id: "input-1",
      type: "input",
      threadId: "thread-adviser",
      turnId: "turn-handling-1",
      prompt: "Which target?",
    });
    expect(deadlines[0]?.cancelled).toBe(true);
    expect(harness.appServer.calls.map(({ operation }) => operation)).not.toContain(
      "respond-operator-wait",
    );

    const unauthenticated = await runCliProcess([
      "requests",
      "--cwd",
      harness.cwd,
      "--mesh-run",
      harness.meshRunId,
      "--operator-credential",
      "not-the-operator-credential",
    ]);
    expect(unauthenticated.exitCode).toBe(1);
    expect(unauthenticated.stderr).toContain("Operator authentication failed.");

    const listed = await runCliProcess([
      "requests",
      "--cwd",
      harness.cwd,
      "--mesh-run",
      harness.meshRunId,
      "--operator-credential",
      harness.operatorCredential,
    ]);
    expect(listed.exitCode).toBe(0);
    const requests = JSON.parse(listed.stdout) as { requests: Array<Record<string, unknown>> };
    expect(requests.requests).toEqual([
      expect.objectContaining({
        id: "approval-1",
        type: "approval",
        conversationId: "conversation-1",
        status: "pending",
      }),
      expect.objectContaining({
        id: "input-1",
        type: "input",
        conversationId: "conversation-1",
        status: "pending",
      }),
    ]);

    await expect(
      harness.supervisor.respondToOperatorRequest({
        meshRunId: harness.meshRunId,
        requestId: "approval-1",
        response: { type: "approval", decision: "anything" } as never,
      }),
    ).rejects.toThrow("Operator approval decision must be approved or denied.");
    expect(
      harness.appServer.calls.filter(({ operation }) => operation === "respond-operator-wait"),
    ).toHaveLength(0);

    now = 10 * 60 * 1000;
    const approval = await runCliProcess([
      "respond",
      "--cwd",
      harness.cwd,
      "--mesh-run",
      harness.meshRunId,
      "--operator-credential",
      harness.operatorCredential,
      "--request",
      "approval-1",
      "--decision",
      "approved",
    ]);
    expect(approval.exitCode).toBe(0);
    expect(deadlines).toHaveLength(1);

    now = 15 * 60 * 1000;
    let durableBeforeResume = false;
    harness.appServer.observeOperatorResponse(async () => {
      const stored = await harness.supervisor.listOperatorRequests({
        cwd: harness.cwd,
        meshRunId: harness.meshRunId,
      });
      durableBeforeResume =
        stored.find(({ id }) => id === "approval-1")?.status === "resolved" &&
        stored.find(({ id }) => id === "input-1")?.status === "responding" &&
        deadlines.length === 2;
    });
    const input = await runCliProcess([
      "respond",
      "--cwd",
      harness.cwd,
      "--mesh-run",
      harness.meshRunId,
      "--operator-credential",
      harness.operatorCredential,
      "--request",
      "input-1",
      "--answer",
      "src/supervisor.ts",
    ]);
    expect(input.exitCode).toBe(0);
    expect(durableBeforeResume).toBe(true);
    expect(deadlines).toHaveLength(2);
    expect(deadlines[1]?.delay).toBe(3 * 60 * 1000);
    expect(
      harness.appServer.calls.filter(({ operation }) => operation === "respond-operator-wait"),
    ).toEqual([
      {
        operation: "respond-operator-wait",
        requestId: "approval-1",
        response: { type: "approval", decision: "approved" },
      },
      {
        operation: "respond-operator-wait",
        requestId: "input-1",
        response: { type: "input", answer: "src/supervisor.ts" },
      },
    ]);
    const conversation = await harness.supervisor.inspectConversation({
      cwd: harness.cwd,
      conversationId: "conversation-1",
    });
    expect(conversation?.status).toBe("open");

    harness.appServer.completeHandling("Operator-controlled Reply");
    await harness.close();
  });

  test("keeps a failed Operator response retryable and keeps its deadline paused", async () => {
    const deadlines: Array<{ cancelled: boolean }> = [];
    const harness = await startHarness({
      scheduleDeadline: () => {
        const scheduled = { cancelled: false };
        deadlines.push(scheduled);
        return () => {
          scheduled.cancelled = true;
        };
      },
    });
    harness.appServer.holdHandlings();
    await ask(harness.writer, "adviser-id", "Needs a retryable Operator response");
    await waitFor(() => harness.appServer.handlingRequests().length === 1);
    harness.appServer.emitOperatorWait({
      id: "retry-input",
      type: "input",
      threadId: "thread-adviser",
      turnId: "turn-handling-1",
      prompt: "Which path?",
    });
    harness.appServer.failNextOperatorResponse("scripted response delivery failure");

    const failed = await runCliProcess([
      "respond",
      "--cwd",
      harness.cwd,
      "--mesh-run",
      harness.meshRunId,
      "--operator-credential",
      harness.operatorCredential,
      "--request",
      "retry-input",
      "--answer",
      "README.md",
    ]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("scripted response delivery failure");
    const [failedRequest] = await harness.supervisor.listOperatorRequests({
      cwd: harness.cwd,
      meshRunId: harness.meshRunId,
    });
    expect(failedRequest).toEqual(
      expect.objectContaining({
        id: "retry-input",
        status: "delivery_failed",
        response: { type: "input", answer: "README.md" },
        failureMessage: "scripted response delivery failure",
      }),
    );
    expect(deadlines).toHaveLength(2);
    expect(deadlines[1]?.cancelled).toBe(true);

    const retried = await runCliProcess([
      "respond",
      "--cwd",
      harness.cwd,
      "--mesh-run",
      harness.meshRunId,
      "--operator-credential",
      harness.operatorCredential,
      "--request",
      "retry-input",
      "--answer",
      "README.md",
    ]);
    expect(retried.exitCode).toBe(0);
    expect(JSON.parse(retried.stdout)).toEqual(
      expect.objectContaining({
        request: expect.objectContaining({ status: "resolved", id: "retry-input" }),
      }),
    );
    expect(deadlines).toHaveLength(3);
    expect(
      harness.appServer.calls.filter(({ operation }) => operation === "respond-operator-wait"),
    ).toHaveLength(2);

    harness.appServer.completeHandling("Handled after Operator response retry");
    await harness.close();
  });

  test("correlates and pauses a wait emitted during Handling start acknowledgement", async () => {
    let now = 0;
    let deadlineCancelled = false;
    const harness = await startHarness({
      now: () => now,
      scheduleDeadline: () => () => {
        deadlineCancelled = true;
      },
    });
    harness.appServer.holdHandlings();
    harness.appServer.waitOnNextHandlingStart({
      id: "start-wait",
      type: "approval",
      threadId: "thread-adviser",
      turnId: "turn-handling-1",
      prompt: "Approve during start acknowledgement?",
    });
    now = 60_000;
    await ask(harness.writer, "adviser-id", "Wait immediately");
    await waitFor(async () => {
      const requests = await harness.supervisor.listOperatorRequests({
        cwd: harness.cwd,
        meshRunId: harness.meshRunId,
      });
      return requests.length === 1;
    });
    const requests = await harness.supervisor.listOperatorRequests({
      cwd: harness.cwd,
      meshRunId: harness.meshRunId,
    });
    expect(requests[0]).toEqual(
      expect.objectContaining({ id: "start-wait", conversationId: "conversation-1" }),
    );
    expect(deadlineCancelled).toBe(true);

    harness.appServer.completeHandling("Handled after start wait");
    await harness.close();
  });

  test("correlates an MCP elicitation without a Codex turn ID to the sole active Handling", async () => {
    let deadlineCancelled = false;
    const harness = await startHarness({
      scheduleDeadline: () => () => {
        deadlineCancelled = true;
      },
    });
    harness.appServer.holdHandlings();
    await ask(harness.writer, "adviser-id", "Needs MCP input");
    await waitFor(() => harness.appServer.handlingRequests().length === 1);

    harness.appServer.emitOperatorWait({
      id: "elicitation-without-turn",
      type: "input",
      threadId: "thread-adviser",
      prompt: "Provide the requested structured input.",
    });

    const [request] = await harness.supervisor.listOperatorRequests({
      cwd: harness.cwd,
      meshRunId: harness.meshRunId,
    });
    expect(request).toEqual(
      expect.objectContaining({
        id: "elicitation-without-turn",
        conversationId: "conversation-1",
        turnId: "turn-handling-1",
      }),
    );
    expect(deadlineCancelled).toBe(true);

    harness.appServer.completeHandling("Handled after MCP elicitation");
    await harness.close();
  });

  test("interrupts a selected Handling that is cancelled during start acknowledgement", async () => {
    const harness = await startHarness();
    harness.appServer.holdHandlingStarts();
    await ask(harness.writer, "adviser-id", "Cancel during start acknowledgement");
    await waitFor(() => harness.appServer.handlingRequests().length === 1);

    await harness.supervisor.cancelConversation({
      meshRunId: harness.meshRunId,
      conversationId: "conversation-1",
    });
    expect(
      harness.appServer.calls.filter(({ operation }) => operation === "interrupt-turn"),
    ).toEqual([]);
    harness.appServer.releaseHandlingStart();
    await waitFor(
      () =>
        harness.appServer.calls.filter(({ operation }) => operation === "interrupt-turn").length ===
        1,
    );
    const cancelled = await harness.supervisor.inspectConversation({
      cwd: harness.cwd,
      conversationId: "conversation-1",
    });
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.handling?.status).toBe("interrupted");

    await harness.close();
  });

  test("cancels only the selected Conversation and interrupts only its active Handling", async () => {
    const harness = await startHarness();
    harness.appServer.holdHandlings();
    await ask(harness.writer, "adviser-id", "Conversation to cancel");
    await waitFor(() => harness.appServer.handlingRequests().length === 1);
    const adviserLaunch = harness.appServer.threadRequests()[1]?.mcpServer;
    if (!adviserLaunch) {
      throw new Error("Expected Adviser MCP launch.");
    }
    const adviser = McpTestClient.spawn(adviserLaunch);
    await adviser.initialize();
    await send(adviser, "writer-id", "Queued child to cancel");
    await send(harness.writer, "adviser-id", "Unrelated Conversation");
    harness.appServer.emitOperatorWait({
      id: "approval-cancelled",
      type: "approval",
      threadId: "thread-adviser",
      turnId: "turn-handling-1",
      prompt: "This wait will be cancelled.",
    });
    harness.appServer.failNextOperatorResponse("scripted cancellation-bound response failure");
    const failedResponse = await runCliProcess([
      "respond",
      "--cwd",
      harness.cwd,
      "--mesh-run",
      harness.meshRunId,
      "--operator-credential",
      harness.operatorCredential,
      "--request",
      "approval-cancelled",
      "--decision",
      "denied",
    ]);
    expect(failedResponse.exitCode).toBe(1);
    const preservedPath = join(harness.cwd, "completed-effect.txt");
    await writeFile(preservedPath, "already happened");

    const cancelledIo = await runCliProcess([
      "cancel",
      "--cwd",
      harness.cwd,
      "--mesh-run",
      harness.meshRunId,
      "--operator-credential",
      harness.operatorCredential,
      "--conversation",
      "conversation-1",
    ]);
    expect(cancelledIo.exitCode).toBe(0);
    expect(JSON.parse(cancelledIo.stdout)).toEqual({
      status: "cancelled",
      conversationId: "conversation-1",
      effectsReversible: false,
      warning: "Cancellation cannot undo completed filesystem or external effects.",
    });
    await waitFor(() => harness.appServer.handlingRequests().length === 2);

    const cancelled = await harness.supervisor.inspectConversation({
      cwd: harness.cwd,
      conversationId: "conversation-1",
    });
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.deliveries[1]?.status).toBe("cancelled");
    expect(cancelled?.handlings[0]?.status).toBe("interrupted");
    expect(
      harness.appServer.calls.filter(({ operation }) => operation === "interrupt-turn"),
    ).toEqual([
      {
        operation: "interrupt-turn",
        threadId: "thread-adviser",
        turnId: "turn-handling-1",
      },
    ]);
    expect(await Bun.file(preservedPath).text()).toBe("already happened");
    expect(
      (
        await harness.supervisor.listOperatorRequests({
          cwd: harness.cwd,
          meshRunId: harness.meshRunId,
        })
      )[0]?.status,
    ).toBe("cancelled");
    const retryAfterCancellation = await runCliProcess([
      "respond",
      "--cwd",
      harness.cwd,
      "--mesh-run",
      harness.meshRunId,
      "--operator-credential",
      harness.operatorCredential,
      "--request",
      "approval-cancelled",
      "--decision",
      "denied",
    ]);
    expect(retryAfterCancellation.exitCode).toBe(1);
    expect(retryAfterCancellation.stderr).toContain("is not awaiting a response");
    expect(
      harness.appServer.calls.filter(({ operation }) => operation === "respond-operator-wait"),
    ).toHaveLength(1);
    const rejectedAfterCancellation = await send(adviser, "writer-id", "Late cancelled work");
    expect(rejectedAfterCancellation.error?.code).toBe(-32000);
    expect(cancelled?.messages).toHaveLength(2);

    await waitFor(async () => {
      const unrelated = await harness.supervisor.inspectConversation({
        cwd: harness.cwd,
        conversationId: "conversation-2",
      });
      return unrelated?.status === "completed";
    });
    expect(harness.appServer.handlingRequests()[1]?.message.body).toBe("Unrelated Conversation");

    await adviser.close();
    await harness.close();
  });
});

async function startHarness(
  options: {
    now?: () => number;
    scheduleDeadline?: (callback: () => void, delay: number) => () => void;
  } = {},
): Promise<{
  cwd: string;
  meshRunId: string;
  operatorCredential: string;
  writer: McpTestClient;
  appServer: ScriptedAppServer;
  supervisor: ReturnType<typeof createSupervisor>;
  close(): Promise<void>;
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
    "nested-1",
    "notification-2",
    "conversation-2",
    "reply-1",
  ];
  let generatedFallback = 0;
  const supervisor = createSupervisor({
    appServer,
    ...options,
    generateOpaqueValue: () => {
      generatedFallback += 1;
      return generated.shift() ?? `fallback-${generatedFallback}`;
    },
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
  return {
    cwd,
    meshRunId: started.meshRun.id,
    operatorCredential: started.operatorCredential,
    writer,
    appServer,
    supervisor,
    async close() {
      await writer.close();
      await supervisor.stop({ meshRunId: started.meshRun.id });
    },
  };
}

async function runCliProcess(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
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
  throw new Error("Timed out waiting for Operator control state.");
}
