import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeshConfiguration } from "../../src/supervisor.ts";

export class TestRepository {
  readonly #directories: string[] = [];

  async directory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "codex-meshd-test-"));
    this.#directories.push(directory);
    return directory;
  }

  async gitRepository(): Promise<string> {
    const directory = await this.directory();
    this.git(directory, "init", "--quiet");
    this.git(directory, "config", "user.email", "test@example.com");
    this.git(directory, "config", "user.name", "Test User");
    return directory;
  }

  async writeConfiguration(
    repository: string,
    configuration: unknown = validConfiguration(),
    options: { tracked?: boolean } = {},
  ): Promise<string> {
    const path = join(repository, "codex-mesh.json");
    await writeFile(path, JSON.stringify(configuration));
    if (options.tracked !== false) {
      this.git(repository, "add", "codex-mesh.json");
    }
    return path;
  }

  git(cwd: string, ...args: string[]): void {
    const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString());
    }
  }

  track(directory: string): void {
    this.#directories.push(directory);
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.#directories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
  }
}

export function validConfiguration(): MeshConfiguration {
  return {
    version: 1,
    agents: [
      {
        name: "writer",
        role: "writer",
        objective: "Implement the bounded Repository change",
        model: { name: "gpt-5.6-sol", reasoningEffort: "high" },
        trustedInstructions: "Modify the Repository only within the Objective.",
        capabilities: ["code", "tests"],
      },
      {
        name: "adviser",
        role: "adviser",
        objective: "Inspect and advise without modifying the Repository",
        model: { name: "gpt-5.6-sol", reasoningEffort: "high" },
        trustedInstructions: "Remain read-only and answer bounded Questions.",
        capabilities: ["review"],
      },
    ],
  };
}

export async function canonicalGitDirectory(repository: string): Promise<string> {
  return realpath(join(repository, ".git"));
}
