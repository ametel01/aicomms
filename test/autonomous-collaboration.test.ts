import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSupervisor } from "../src/supervisor.ts";
import { McpTestClient } from "./support/mcp-client.ts";
import { TestRepository } from "./support/repository.ts";
import { ScriptedAppServer } from "./support/scripted-app-server.ts";

const testRepository = new TestRepository();

afterEach(async () => {
  await testRepository.cleanup();
});

describe("autonomous Writer-Adviser collaboration", () => {
  test("routes one design Question and applies one verified bounded Repository change", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const target = join(cwd, "boundary.txt");
    await writeFile(join(cwd, ".gitignore"), ".codex-meshd/\n");
    await writeFile(target, "shared mutable state\n");
    testRepository.git(cwd, "add", ".gitignore", "boundary.txt");
    testRepository.git(cwd, "commit", "--quiet", "-m", "baseline");

    const appServer = new ScriptedAppServer();
    const handled: string[] = [];
    appServer.scriptHandlings(async (request) => {
      handled.push(`${request.threadId}:${request.message.kind}`);
      if (request.threadId === "thread-adviser") {
        expect(request.message.body).toBe(
          "Inspect the shared mutable state flaw in boundary.txt and recommend one bounded change.",
        );
        expect(testRepository.gitOutput(cwd, "status", "--short")).toBe("");
        return { finalOutput: "Replace it with one Supervisor-owned boundary." };
      }
      expect(request.message.kind).toBe("reply");
      expect(request.message.body).toBe("Replace it with one Supervisor-owned boundary.");
      await writeFile(target, "single Supervisor-owned boundary\n");
      expect(await readFile(target, "utf8")).toBe("single Supervisor-owned boundary\n");
      return { finalOutput: "Applied and verified boundary.txt." };
    });

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
      generateOpaqueValue: () => generated.shift() ?? "unexpected-id",
      conversationLimits: {
        agentTriggeredMessages: 1,
        totalMessages: 2,
        elapsedMilliseconds: 60_000,
      },
    });
    const started = await supervisor.start({ cwd, configurationPath });
    if (started.status !== "running") {
      throw new Error("Expected Mesh startup to succeed.");
    }
    const writerLaunch = appServer.threadRequests()[0]?.mcpServer;
    if (!writerLaunch) {
      throw new Error("Expected Writer MCP launch.");
    }
    const writer = McpTestClient.spawn(writerLaunch);
    await writer.initialize();

    try {
      const asked = await writer.request("tools/call", {
        name: "agents.ask",
        arguments: {
          agent_id: "adviser-id",
          body: "Inspect the shared mutable state flaw in boundary.txt and recommend one bounded change.",
          context: { file_references: ["boundary.txt"] },
        },
      });
      expect(content(asked)).toEqual({ message_id: "question-1" });
      await waitFor(() => handled.includes("thread-adviser:question"));
      await waitFor(async () => {
        const snapshot = await supervisor.inspectConversation({
          cwd,
          conversationId: "conversation-1",
        });
        return snapshot?.messages.length === 2;
      });
      expect(testRepository.gitOutput(cwd, "status", "--short")).toBe("");

      appServer.emitThreadStatus("thread-writer", "idle");
      await waitFor(() => handled.includes("thread-writer:reply"));
      await waitFor(async () => {
        const snapshot = await supervisor.inspectConversation({
          cwd,
          conversationId: "conversation-1",
        });
        return snapshot?.status === "completed";
      });

      expect(testRepository.gitOutput(cwd, "diff", "--", "boundary.txt")).toContain(
        "+single Supervisor-owned boundary",
      );
      expect(testRepository.gitOutput(cwd, "diff", "--name-only")).toBe("boundary.txt");
      expect(handled).toEqual(["thread-adviser:question", "thread-writer:reply"]);

      const conversation = await supervisor.inspectConversation({
        cwd,
        conversationId: "conversation-1",
      });
      expect(conversation).toMatchObject({
        id: "conversation-1",
        status: "completed",
        messages: [
          {
            id: "question-1",
            kind: "question",
            senderAgentId: "writer-id",
            recipientAgentId: "adviser-id",
            conversationId: "conversation-1",
            fileReferences: ["boundary.txt"],
          },
          {
            id: "reply-1",
            kind: "reply",
            senderAgentId: "adviser-id",
            recipientAgentId: "writer-id",
            conversationId: "conversation-1",
            inReplyTo: "question-1",
          },
        ],
        deliveries: [
          { messageId: "question-1", status: "injected", codexTurnId: "turn-handling-1" },
          { messageId: "reply-1", status: "injected", codexTurnId: "turn-handling-2" },
        ],
        handlings: [
          { messageId: "question-1", status: "completed", codexTurnId: "turn-handling-1" },
          { messageId: "reply-1", status: "completed", codexTurnId: "turn-handling-2" },
        ],
      });
      expect(conversation?.messages).toHaveLength(2);
      expect(conversation?.events.map(({ type }) => type)).toEqual([
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
      expect(appServer.threadRequests().map(({ role, sandbox }) => ({ role, sandbox }))).toEqual([
        { role: "writer", sandbox: "workspace-write" },
        { role: "adviser", sandbox: "read-only" },
      ]);
    } finally {
      await writer.close();
      await supervisor.stop({ meshRunId: started.meshRun.id });
    }
  });
});

function content(response: { result?: unknown }): unknown {
  const result = response.result as { content?: Array<{ text?: string }> } | undefined;
  const text = result?.content?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for autonomous collaboration evidence.");
}
