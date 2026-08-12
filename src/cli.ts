#!/usr/bin/env bun

import { createSupervisor, type StartMeshResult } from "./supervisor.ts";

interface CliIo {
  stdout: Pick<typeof process.stdout, "write">;
  stderr: Pick<typeof process.stderr, "write">;
}

export async function runCli(
  args: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const [command, ...options] = args;
  if (command !== "start") {
    return writeError(io, {
      status: "rejected",
      errors: [
        {
          code: "cli.command_invalid",
          message: "Usage: codex-meshd start --config <path> [--cwd <path>]",
        },
      ],
    });
  }

  const configurationPath = readOption(options, "--config");
  const cwd = readOption(options, "--cwd") ?? process.cwd();
  if (!configurationPath) {
    return writeError(io, {
      status: "rejected",
      errors: [{ code: "cli.config_required", message: "The --config option is required." }],
    });
  }

  const result = await createSupervisor().start({ cwd, configurationPath });
  if (result.status === "rejected") {
    return writeError(io, result);
  }
  io.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  return value?.startsWith("--") === true ? undefined : value;
}

function writeError(io: CliIo, result: Extract<StartMeshResult, { status: "rejected" }>): number {
  io.stderr.write(`${JSON.stringify(result)}\n`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
