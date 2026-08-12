import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TestRepository } from "./support/repository.ts";

const testRepository = new TestRepository();

afterEach(async () => {
  await testRepository.cleanup();
});

describe("codex-meshd start", () => {
  test("prints the same deterministic validation errors as the Supervisor Interface", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd, {
      version: 1,
      agents: [],
    });

    const child = Bun.spawn(
      [process.execPath, "run", "src/cli.ts", "start", "--config", configurationPath, "--cwd", cwd],
      {
        cwd: import.meta.dir.endsWith("/test") ? join(import.meta.dir, "..") : import.meta.dir,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toEqual({
      status: "rejected",
      errors: [
        {
          code: "configuration.agents.exactly_two",
          message: "Mesh Configuration must declare exactly two Agents.",
          path: "agents",
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
      ],
    });
  });

  test("rejects a missing --config value deterministically", async () => {
    const cwd = await testRepository.gitRepository();
    const child = Bun.spawn(
      [process.execPath, "run", "src/cli.ts", "start", "--config", "--cwd", cwd],
      {
        cwd: import.meta.dir.endsWith("/test") ? join(import.meta.dir, "..") : import.meta.dir,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr)).toEqual({
      status: "rejected",
      errors: [
        {
          code: "cli.config_required",
          message: "The --config option is required.",
        },
      ],
    });
  });
});
