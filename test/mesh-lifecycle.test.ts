import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSupervisor } from "../src/supervisor.ts";
import { TestRepository } from "./support/repository.ts";
import { ScriptedAppServer, type ScriptedFailure } from "./support/scripted-app-server.ts";

const testRepository = new TestRepository();

afterEach(async () => {
  await testRepository.cleanup();
});

describe("Mesh Run lifecycle", () => {
  test("reports a store prerequisite failure before starting app-server work", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    await writeFile(join(cwd, ".codex-meshd"), "blocks the state directory");
    const appServer = new ScriptedAppServer();
    const supervisor = createSupervisor({
      appServer,
      generateOpaqueValue: () => "generated-value",
    });

    const result = await supervisor.start({ cwd, configurationPath });

    expect(result).toEqual({
      status: "failed",
      meshRunId: "generated-value",
      error: {
        code: "startup.prerequisite_failed",
        message: expect.any(String),
      },
    });
    expect(appServer.calls.filter((call) => call.operation !== "close")).toEqual([]);
  });

  test("starts two ready Agents before activating only the Writer", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const appServer = new ScriptedAppServer();
    const generatedValues = [
      "run-1",
      "agent-writer",
      "credential-writer",
      "agent-adviser",
      "credential-adviser",
    ];
    const supervisor = createSupervisor({
      appServer,
      generateOpaqueValue: () => generatedValues.shift() ?? "unexpected-generated-value",
    });

    const result = await supervisor.start({ cwd, configurationPath });

    expect(result).toEqual({
      status: "running",
      meshRun: {
        id: "run-1",
        status: "running",
        repositoryId: expect.any(String),
        agents: [
          {
            id: "agent-writer",
            name: "writer",
            role: "writer",
            objective: "Implement the bounded Repository change",
            capabilities: ["code", "tests"],
            threadId: "thread-writer",
            status: "working",
          },
          {
            id: "agent-adviser",
            name: "adviser",
            role: "adviser",
            objective: "Inspect and advise without modifying the Repository",
            capabilities: ["review"],
            threadId: "thread-adviser",
            status: "idle",
          },
        ],
      },
    });
    expect(appServer.calls).toEqual([
      { operation: "initialize" },
      {
        operation: "start-thread",
        request: expect.objectContaining({
          agentId: "agent-writer",
          agentCredential: "credential-writer",
          role: "writer",
          sandbox: "workspace-write",
        }),
      },
      {
        operation: "start-thread",
        request: expect.objectContaining({
          agentId: "agent-adviser",
          agentCredential: "credential-adviser",
          role: "adviser",
          sandbox: "read-only",
        }),
      },
      {
        operation: "start-objective",
        request: {
          threadId: "thread-writer",
          objective: "Implement the bounded Repository change",
          roster: [
            expect.objectContaining({ id: "agent-writer", role: "writer" }),
            expect.objectContaining({ id: "agent-adviser", role: "adviser" }),
          ],
        },
      },
    ]);
  });

  for (const failure of [
    "initialize",
    "writer-thread",
    "adviser-thread",
    "mcp",
    "writer-objective",
  ] as const) {
    test(`records ${failure} failure without starting either Objective`, async () => {
      const cwd = await testRepository.gitRepository();
      const configurationPath = await testRepository.writeConfiguration(cwd);
      const appServer = new ScriptedAppServer(failure satisfies ScriptedFailure);
      const supervisor = createSupervisor({ appServer });

      const result = await supervisor.start({ cwd, configurationPath });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") {
        throw new Error("Expected Mesh startup to fail.");
      }
      expect(result.error.code).toBe("startup.prerequisite_failed");
      const objectiveCalls = appServer.calls.filter((call) => call.operation === "start-objective");
      expect(objectiveCalls).toHaveLength(failure === "writer-objective" ? 1 : 0);
      expect(appServer.calls.at(-1)).toEqual({ operation: "close" });

      const persisted = await createSupervisor().inspectMeshRun({
        cwd,
        meshRunId: result.meshRunId,
      });
      expect(persisted?.status).toBe("failed");
      expect(persisted?.failureMessage).toBe(result.error.message);
      expect(persisted?.agents.map((agent) => agent.status)).toEqual(["stopped", "stopped"]);
    });
  }

  test("stops owned resources and preserves the terminal Mesh Run", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const appServer = new ScriptedAppServer();
    const supervisor = createSupervisor({ appServer });
    const started = await supervisor.start({ cwd, configurationPath });
    if (started.status !== "running") {
      throw new Error("Expected Mesh startup to succeed.");
    }

    const stopped = await supervisor.stop({ meshRunId: started.meshRun.id });

    expect(stopped).toEqual({ status: "stopped", meshRunId: started.meshRun.id });
    expect(appServer.calls.at(-1)).toEqual({ operation: "close" });
    expect(appServer.calls.map((call): string => call.operation)).not.toContain("delete-thread");

    const persisted = await createSupervisor().inspectMeshRun({
      cwd,
      meshRunId: started.meshRun.id,
    });
    expect(persisted?.status).toBe("stopped");
    expect(persisted?.agents.map((agent) => agent.status)).toEqual(["stopped", "stopped"]);
  });

  test("records a failed Mesh Run when owned resources do not close", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const appServer = new ScriptedAppServer("close");
    const supervisor = createSupervisor({ appServer });
    const started = await supervisor.start({ cwd, configurationPath });
    if (started.status !== "running") {
      throw new Error("Expected Mesh startup to succeed.");
    }

    await expect(supervisor.stop({ meshRunId: started.meshRun.id })).rejects.toThrow(
      "scripted close failure",
    );

    const persisted = await createSupervisor().inspectMeshRun({
      cwd,
      meshRunId: started.meshRun.id,
    });
    expect(persisted?.status).toBe("failed");
    expect(persisted?.failureMessage).toBe("scripted close failure");
  });
});
