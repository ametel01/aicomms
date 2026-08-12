import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createSupervisor } from "../src/supervisor.ts";
import { canonicalGitDirectory, TestRepository, validConfiguration } from "./support/repository.ts";
import { ScriptedAppServer } from "./support/scripted-app-server.ts";

const testRepository = new TestRepository();

afterEach(async () => {
  await testRepository.cleanup();
});

describe("Supervisor.start", () => {
  test("rejects startup outside a Git Repository", async () => {
    const cwd = await testRepository.directory();

    const result = await createSupervisor().start({ cwd, configurationPath: "codex-mesh.json" });

    expect(result).toEqual({
      status: "rejected",
      errors: [
        {
          code: "repository.not_git",
          message: "Startup requires a Git Repository.",
        },
      ],
    });
  });

  test("reports deterministic Mesh Configuration errors", async () => {
    const cwd = await testRepository.gitRepository();
    const invalidConfiguration = {
      version: 1,
      agents: [
        {
          name: "same-name",
          role: "writer",
          objective: "",
          model: {},
          trustedInstructions: "",
          capabilities: ["code", 42],
        },
        {
          name: "same-name",
          role: "writer",
          objective: "Second Writer",
          model: { name: "gpt-5.6-sol" },
          trustedInstructions: "Write code.",
          capabilities: [],
        },
      ],
    };

    const configurationPath = await testRepository.writeConfiguration(cwd, invalidConfiguration);
    const result = await createSupervisor().start({ cwd, configurationPath });

    expect(result).toEqual({
      status: "rejected",
      errors: [
        {
          code: "configuration.agent.name_duplicate",
          message: 'Agent Name "same-name" must be unique.',
          path: "agents[1].name",
        },
        {
          code: "configuration.writer.exactly_one",
          message: "Mesh Configuration must declare exactly one Writer.",
          path: "agents",
        },
        {
          code: "configuration.adviser.exactly_one",
          message: "Mesh Configuration must declare exactly one Adviser.",
          path: "agents",
        },
        {
          code: "configuration.agent.objective_required",
          message: "Agent Objective must be a non-empty string.",
          path: "agents[0].objective",
        },
        {
          code: "configuration.agent.model_name_required",
          message: "Agent model name must be a non-empty string.",
          path: "agents[0].model.name",
        },
        {
          code: "configuration.agent.instructions_required",
          message: "Agent trusted instructions must be a non-empty string.",
          path: "agents[0].trustedInstructions",
        },
        {
          code: "configuration.agent.capability_invalid",
          message: "Every Agent Capability must be a non-empty string.",
          path: "agents[0].capabilities[1]",
        },
        {
          code: "configuration.agent.capability_required",
          message: "Agent Configuration must declare at least one descriptive Capability.",
          path: "agents[1].capabilities",
        },
      ],
    });
  });

  test("rejects a Mesh Configuration that is not tracked by Git", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd, validConfiguration(), {
      tracked: false,
    });

    const result = await createSupervisor().start({ cwd, configurationPath });

    expect(result).toEqual({
      status: "rejected",
      errors: [
        {
          code: "configuration.not_tracked",
          message: "Mesh Configuration must be tracked by Git.",
          path: configurationPath,
        },
      ],
    });
  });

  test("uses one Repository identity for a Repository and its linked worktree", async () => {
    const repository = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(repository);
    testRepository.git(repository, "commit", "--quiet", "-m", "Initial commit");
    const worktree = `${repository}-worktree`;
    testRepository.git(repository, "worktree", "add", "--quiet", "-b", "test-worktree", worktree);
    testRepository.track(worktree);

    const repositorySupervisor = createSupervisor({ appServer: new ScriptedAppServer() });
    const repositoryResult = await repositorySupervisor.start({
      cwd: repository,
      configurationPath,
    });
    const worktreeSupervisor = createSupervisor({ appServer: new ScriptedAppServer() });
    const worktreeResult = await worktreeSupervisor.start({
      cwd: worktree,
      configurationPath: `${worktree}/codex-mesh.json`,
    });

    expect(repositoryResult.status).toBe("running");
    expect(worktreeResult.status).toBe("running");
    if (repositoryResult.status !== "running" || worktreeResult.status !== "running") {
      throw new Error("Expected both Mesh Runs to start.");
    }
    expect(worktreeResult.meshRun.repositoryId).toBe(repositoryResult.meshRun.repositoryId);
    expect(repositoryResult.meshRun.repositoryId).toBe(
      createHash("sha256")
        .update(await canonicalGitDirectory(repository))
        .digest("hex"),
    );

    await repositorySupervisor.stop({ meshRunId: repositoryResult.meshRun.id });
    await worktreeSupervisor.stop({ meshRunId: worktreeResult.meshRun.id });
  });
});
