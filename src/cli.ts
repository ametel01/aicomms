#!/usr/bin/env bun

import {
  cancelConversationOverSocket,
  listOperatorRequestsOverSocket,
  respondToOperatorRequestOverSocket,
} from "./operator-client.ts";
import { createSupervisor, type StartMeshResult, type Supervisor } from "./supervisor.ts";

interface CliIo {
  stdout: Pick<typeof process.stdout, "write">;
  stderr: Pick<typeof process.stderr, "write">;
}

export async function runCli(
  args: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  supervisor?: Supervisor,
): Promise<number> {
  const [command, ...options] = args;
  if (command === "requests") {
    const meshRunId = readOption(options, "--mesh-run");
    const cwd = readOption(options, "--cwd") ?? process.cwd();
    const operatorCredential = readOperatorCredential(options);
    if (!supervisor && !operatorCredential) {
      return writeCliError(io, "Operator credential is required.");
    }
    try {
      const requests = supervisor
        ? await supervisor.listOperatorRequests({ cwd, ...(meshRunId ? { meshRunId } : {}) })
        : await listOperatorRequestsOverSocket(cwd, operatorCredential as string, meshRunId);
      io.stdout.write(`${JSON.stringify({ requests })}\n`);
      return 0;
    } catch (cause) {
      return writeCliError(io, cause instanceof Error ? cause.message : "Request listing failed.");
    }
  }
  if (command === "respond") {
    return runRespond(options, io, supervisor);
  }
  if (command === "cancel") {
    return runCancel(options, io, supervisor);
  }
  if (command === "inspect") {
    return runInspect(options, io, supervisor);
  }
  if (command === "logs") {
    return runLogs(options, io, supervisor);
  }
  if (command === "purge") {
    return runPurge(options, io, supervisor);
  }
  if (command !== "start") {
    return writeError(io, {
      status: "rejected",
      errors: [
        {
          code: "cli.command_invalid",
          message:
            "Usage: codex-meshd <start|requests|respond|cancel|inspect|logs|purge> [options]",
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

  const result = await (supervisor ?? createSupervisor()).start({ cwd, configurationPath });
  if (result.status !== "running") {
    return writeError(io, result);
  }
  io.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function runInspect(
  options: string[],
  io: CliIo,
  supervisor: Supervisor | undefined,
): Promise<number> {
  const cwd = readOption(options, "--cwd") ?? process.cwd();
  const meshRunId = readOption(options, "--mesh-run");
  try {
    const evidence = await (supervisor ?? createSupervisor()).inspectEvidence({
      cwd,
      ...(meshRunId ? { meshRunId } : {}),
    });
    io.stdout.write(`${JSON.stringify({ evidence })}\n`);
    return 0;
  } catch (cause) {
    return writeCliError(
      io,
      cause instanceof Error ? cause.message : "Evidence inspection failed.",
    );
  }
}

async function runLogs(
  options: string[],
  io: CliIo,
  supervisor: Supervisor | undefined,
): Promise<number> {
  const cwd = readOption(options, "--cwd") ?? process.cwd();
  const meshRunId = readOption(options, "--mesh-run");
  const afterValue = readOption(options, "--after");
  const afterSequence = afterValue === undefined ? 0 : Number(afterValue);
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    return writeCliError(io, "--after must be a non-negative safe integer.");
  }
  const follow = options.includes("--follow");
  const service = supervisor ?? createSupervisor();
  let cursor = afterSequence;
  try {
    do {
      const events = await service.listStructuredEvents({
        cwd,
        afterSequence: cursor,
        ...(meshRunId ? { meshRunId } : {}),
      });
      for (const event of events) {
        io.stdout.write(`${JSON.stringify(event)}\n`);
        cursor = event.sequence;
      }
      if (follow) {
        await Bun.sleep(250);
      }
    } while (follow);
    return 0;
  } catch (cause) {
    return writeCliError(io, cause instanceof Error ? cause.message : "Structured log failed.");
  }
}

async function runPurge(
  options: string[],
  io: CliIo,
  supervisor: Supervisor | undefined,
): Promise<number> {
  const cwd = readOption(options, "--cwd") ?? process.cwd();
  const confirmed = options.includes("--confirm");
  try {
    const result = await (supervisor ?? createSupervisor()).purgeEvidence({ cwd, confirmed });
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (cause) {
    return writeCliError(io, cause instanceof Error ? cause.message : "Evidence purge failed.");
  }
}

async function runRespond(
  options: string[],
  io: CliIo,
  supervisor: Supervisor | undefined,
): Promise<number> {
  const meshRunId = readOption(options, "--mesh-run");
  const requestId = readOption(options, "--request");
  const decision = readOption(options, "--decision");
  const answer = readOption(options, "--answer");
  const cwd = readOption(options, "--cwd") ?? process.cwd();
  const operatorCredential = readOperatorCredential(options);
  if (!meshRunId || !requestId) {
    return writeCliError(io, "respond requires --mesh-run and --request.");
  }
  if (!supervisor && !operatorCredential) {
    return writeCliError(io, "Operator credential is required.");
  }
  if (decision !== undefined && decision !== "approved" && decision !== "denied") {
    return writeCliError(io, "--decision must be approved or denied.");
  }
  if ((decision === undefined) === (answer === undefined)) {
    return writeCliError(io, "respond requires exactly one of --decision or --answer.");
  }
  try {
    const response =
      decision === "approved" || decision === "denied"
        ? ({ type: "approval", decision } as const)
        : ({ type: "input", answer: answer as string } as const);
    const request = supervisor
      ? await supervisor.respondToOperatorRequest({ meshRunId, requestId, response })
      : await respondToOperatorRequestOverSocket(
          cwd,
          operatorCredential as string,
          meshRunId,
          requestId,
          response,
        );
    io.stdout.write(`${JSON.stringify({ request })}\n`);
    return 0;
  } catch (cause) {
    return writeCliError(io, cause instanceof Error ? cause.message : "Operator response failed.");
  }
}

async function runCancel(
  options: string[],
  io: CliIo,
  supervisor: Supervisor | undefined,
): Promise<number> {
  const meshRunId = readOption(options, "--mesh-run");
  const conversationId = readOption(options, "--conversation");
  const cwd = readOption(options, "--cwd") ?? process.cwd();
  const operatorCredential = readOperatorCredential(options);
  if (!meshRunId || !conversationId) {
    return writeCliError(io, "cancel requires --mesh-run and --conversation.");
  }
  if (!supervisor && !operatorCredential) {
    return writeCliError(io, "Operator credential is required.");
  }
  try {
    const result = supervisor
      ? await supervisor.cancelConversation({ meshRunId, conversationId })
      : await cancelConversationOverSocket(
          cwd,
          operatorCredential as string,
          meshRunId,
          conversationId,
        );
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (cause) {
    return writeCliError(io, cause instanceof Error ? cause.message : "Cancellation failed.");
  }
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  return value?.startsWith("--") === true ? undefined : value;
}

function readOperatorCredential(args: string[]): string | undefined {
  return readOption(args, "--operator-credential") ?? process.env.CODEX_MESHD_OPERATOR_CREDENTIAL;
}

function writeError(io: CliIo, result: Exclude<StartMeshResult, { status: "running" }>): number {
  io.stderr.write(`${JSON.stringify(result)}\n`);
  return 1;
}

function writeCliError(io: CliIo, message: string): number {
  io.stderr.write(`${JSON.stringify({ status: "error", message })}\n`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
