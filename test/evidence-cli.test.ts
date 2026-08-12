import { afterEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createSupervisor } from "../src/supervisor.ts";
import { McpTestClient } from "./support/mcp-client.ts";
import { TestRepository } from "./support/repository.ts";
import { ScriptedAppServer } from "./support/scripted-app-server.ts";

const testRepository = new TestRepository();

afterEach(async () => {
  await testRepository.cleanup();
});

describe("durable evidence CLI", () => {
  test("inspects and follows retained evidence until an explicit inactive purge", async () => {
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
      arguments: { agent_id: "adviser-id", body: "Inspect the durable evidence" },
    });
    await waitFor(() => appServer.handlingRequests().length === 1);
    appServer.emitThreadStatus("thread-writer", "idle");
    await waitFor(async () => {
      const conversation = await supervisor.inspectConversation({
        cwd,
        conversationId: "conversation-1",
      });
      return conversation?.status === "completed";
    });

    const stateDirectory = join(cwd, ".codex-meshd");
    expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateDirectory, "transcript.sqlite"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(stateDirectory, "supervisor.sock"))).mode & 0o777).toBe(0o600);

    const activePurge = await runCliProcess(["purge", "--cwd", cwd, "--confirm"]);
    expect(activePurge.exitCode).toBe(1);
    expect(activePurge.stderr).toContain("while a Supervisor is active");

    await writer.close();
    await supervisor.stop({ meshRunId: "run-1" });
    expect(await Bun.file(join(stateDirectory, "transcript.sqlite")).exists()).toBe(true);

    const inspected = await runCliProcess(["inspect", "--cwd", cwd, "--mesh-run", "run-1"]);
    expect(inspected.exitCode).toBe(0);
    const evidence = (
      JSON.parse(inspected.stdout) as {
        evidence: Record<string, unknown[]> & {
          events: Array<{ sequence: number; type: string }>;
        };
      }
    ).evidence;
    expect(evidence.meshRuns).toHaveLength(1);
    expect(evidence.agents).toHaveLength(2);
    expect(evidence.conversations).toEqual([
      expect.objectContaining({ id: "conversation-1", status: "completed" }),
    ]);
    expect(evidence.messages).toHaveLength(2);
    expect(evidence.deliveries).toEqual([
      expect.objectContaining({ messageId: "question-1", codexTurnId: "turn-handling-1" }),
      expect.objectContaining({ messageId: "reply-1", codexTurnId: "turn-handling-1" }),
    ]);
    expect(evidence.handlings).toHaveLength(2);
    expect(evidence.notices).toEqual([]);
    expect(evidence.operatorRequests).toEqual([]);

    const logs = await runCliProcess(["logs", "--cwd", cwd, "--mesh-run", "run-1"]);
    expect(logs.exitCode).toBe(0);
    const events = logs.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { sequence: number; type: string });
    expect(events).toEqual(evidence.events);
    expect(events.map(({ type }) => type)).toEqual([
      "message.accepted",
      "delivery.injecting",
      "delivery.injected",
      "handling.active",
      "handling.completed",
      "message.accepted",
      "delivery.queued",
      "delivery.injecting",
      "delivery.injected",
      "handling.active",
      "handling.completed",
      "conversation.completed",
    ]);
    const after = await runCliProcess([
      "logs",
      "--cwd",
      cwd,
      "--after",
      String(events[0]?.sequence),
    ]);
    expect(after.stdout.trim().split("\n")).toHaveLength(events.length - 1);

    const unconfirmed = await runCliProcess(["purge", "--cwd", cwd]);
    expect(unconfirmed.exitCode).toBe(1);
    expect(unconfirmed.stderr).toContain("explicit confirmation");
    expect(await Bun.file(join(stateDirectory, "transcript.sqlite")).exists()).toBe(true);

    const purged = await runCliProcess(["purge", "--cwd", cwd, "--confirm"]);
    expect(purged).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify({ status: "purged" })}\n`,
      stderr: "",
    });
    expect(await Bun.file(join(stateDirectory, "transcript.sqlite")).exists()).toBe(false);
  });
});

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

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for durable evidence state.");
}
