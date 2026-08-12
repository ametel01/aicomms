import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_PROTOCOL_BASELINE,
  createCodexAppServerAdapter,
  validateCodexCompatibility,
} from "../src/codex-app-server.ts";
import { DiscoveryServer } from "../src/discovery-server.ts";
import type { PublicAgent } from "../src/startup-validation.ts";
import { TestRepository } from "./support/repository.ts";

const testRepository = new TestRepository();

afterEach(async () => {
  await testRepository.cleanup();
});

describe("installed Codex app-server compatibility", () => {
  test("keeps the checked schema bundle identical to the pinned generator output", async () => {
    const generated = await testRepository.directory();
    const generation = Bun.spawn(
      ["codex", "app-server", "generate-json-schema", "--experimental", "--out", generated],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await generation.exited).toBe(0);
    const checked = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "protocol",
      `codex-${CODEX_PROTOCOL_BASELINE}`,
    );
    const comparison = Bun.spawn(["diff", "-qr", checked, generated], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      comparison.exited,
      new Response(comparison.stdout).text(),
      new Response(comparison.stderr).text(),
    ]);
    expect(`${stdout}${stderr}`).toBe("");
    expect(exitCode).toBe(0);
  });

  test("fails fast on an unsupported installed Codex version", async () => {
    const directory = await testRepository.directory();
    const command = join(directory, "unsupported-codex");
    await writeFile(command, "#!/bin/sh\necho 'codex-cli 999.0.0'\n");
    await chmod(command, 0o700);

    await expect(validateCodexCompatibility(command)).rejects.toThrow(
      `Unsupported Codex CLI 999.0.0; codex-meshd requires ${CODEX_PROTOCOL_BASELINE}.`,
    );
  });

  test("retains a final output completed in the turn/start response buffer", async () => {
    const directory = await testRepository.directory();
    const command = await writeFakeCodex(directory);
    const adapter = createCodexAppServerAdapter({ command });
    try {
      await adapter.initialize();
      const handling = await adapter.startHandling({
        threadId: "thread-adviser",
        message: {
          id: "question-1",
          kind: "question",
          senderAgentId: "writer-id",
          recipientAgentId: "adviser-id",
          conversationId: "conversation-1",
          createdAt: "2026-08-12T00:00:00.000Z",
          body: "Inspect the design flaw.",
        },
      });
      expect(handling.turnId).toBe("turn-fast");
      await expect(handling.completed).resolves.toEqual({ finalOutput: "Buffered advice." });
    } finally {
      await adapter.close();
    }
  });

  test("initializes the real baseline and starts two threads with distinct MCP identities", async () => {
    const cwd = await testRepository.gitRepository();
    const codexHome = await testRepository.directory();
    await mkdir(join(cwd, ".codex-meshd"), { recursive: true, mode: 0o700 });
    const agents: PublicAgent[] = [
      {
        id: "smoke-writer",
        name: "writer",
        role: "writer",
        objective: "Compatibility smoke only",
        capabilities: ["code"],
        status: "starting",
      },
      {
        id: "smoke-adviser",
        name: "adviser",
        role: "adviser",
        objective: "Compatibility smoke only",
        capabilities: ["review"],
        status: "starting",
      },
    ];
    const discovery = await DiscoveryServer.start(
      cwd,
      [
        { agentId: "smoke-writer", credential: "writer-credential" },
        { agentId: "smoke-adviser", credential: "adviser-credential" },
      ],
      "operator-credential",
      agents,
      {
        async sendNotification() {
          throw new Error("Smoke test does not send Messages.");
        },
        async askQuestion() {
          throw new Error("Smoke test does not ask Questions.");
        },
        listOperatorRequests: () => [],
        async respondToOperatorRequest() {
          throw new Error("Smoke test does not respond to Operator Requests.");
        },
        async cancelConversation() {
          throw new Error("Smoke test does not cancel Conversations.");
        },
      },
    );
    const writerMcp = discovery.launchFor("smoke-writer", "writer-credential");
    const adviserMcp = discovery.launchFor("smoke-adviser", "adviser-credential");
    expect(writerMcp.env.CODEX_MESHD_AGENT_ID).toBe("smoke-writer");
    expect(adviserMcp.env.CODEX_MESHD_AGENT_ID).toBe("smoke-adviser");
    expect(writerMcp.env.CODEX_MESHD_AGENT_CREDENTIAL).not.toBe(
      adviserMcp.env.CODEX_MESHD_AGENT_CREDENTIAL,
    );

    const adapter = createCodexAppServerAdapter({
      environment: { ...process.env, CODEX_HOME: codexHome },
      ephemeralThreads: true,
    });
    try {
      await expect(adapter.initialize()).resolves.toEqual({
        codexVersion: CODEX_PROTOCOL_BASELINE,
      });
      const writer = await adapter.startThread({
        name: "writer",
        role: "writer",
        objective: "Compatibility smoke only",
        model: { name: "gpt-5.6-sol", reasoningEffort: "high" },
        trustedInstructions: "Do not start a turn.",
        capabilities: ["code"],
        agentId: "smoke-writer",
        agentCredential: "writer-credential",
        repositoryRoot: cwd,
        sandbox: "workspace-write",
        mcpServer: writerMcp,
      });
      const adviser = await adapter.startThread({
        name: "adviser",
        role: "adviser",
        objective: "Compatibility smoke only",
        model: { name: "gpt-5.6-sol", reasoningEffort: "high" },
        trustedInstructions: "Do not start a turn.",
        capabilities: ["review"],
        agentId: "smoke-adviser",
        agentCredential: "adviser-credential",
        repositoryRoot: cwd,
        sandbox: "read-only",
        mcpServer: adviserMcp,
      });
      expect(writer).toEqual({ threadId: expect.any(String), mcpReady: true });
      expect(adviser).toEqual({ threadId: expect.any(String), mcpReady: true });
      expect(writer.threadId).not.toBe(adviser.threadId);
    } finally {
      await adapter.close();
      await discovery.close();
    }
  }, 30_000);
});

async function writeFakeCodex(directory: string): Promise<string> {
  const command = join(directory, "fake-codex");
  await writeFile(
    command,
    `#!/usr/bin/env bun
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log("codex-cli ${CODEX_PROTOCOL_BASELINE}");
  process.exit(0);
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: "fake-codex" } }) + "\\n");
  }
  if (request.method === "turn/start") {
    process.stdout.write([
      { id: request.id, result: { turn: { id: "turn-fast" } } },
      { method: "item/completed", params: { turnId: "turn-fast", item: { type: "agentMessage", text: "Buffered advice." } } },
      { method: "turn/completed", params: { turn: { id: "turn-fast", status: "completed" } } },
    ].map(JSON.stringify).join("\\n") + "\\n");
  }
});
`,
  );
  await chmod(command, 0o700);
  return command;
}
