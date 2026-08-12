import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

export type AgentRole = "writer" | "adviser";

export interface AgentModelOptions {
  name: string;
  reasoningEffort?: string;
}

export interface AgentConfiguration {
  name: string;
  role: AgentRole;
  objective: string;
  model: AgentModelOptions;
  trustedInstructions: string;
  capabilities: string[];
}

export interface MeshConfiguration {
  version: 1;
  agents: [AgentConfiguration, AgentConfiguration];
}

export interface StartMeshRequest {
  cwd: string;
  configurationPath: string;
}

export type StartupValidationCode =
  | "cli.command_invalid"
  | "cli.config_required"
  | "configuration.adviser.exactly_one"
  | "configuration.agent.capabilities_required"
  | "configuration.agent.capability_invalid"
  | "configuration.agent.capability_required"
  | "configuration.agent.instructions_required"
  | "configuration.agent.invalid"
  | "configuration.agent.model_name_required"
  | "configuration.agent.model_required"
  | "configuration.agent.name_duplicate"
  | "configuration.agent.name_required"
  | "configuration.agent.objective_required"
  | "configuration.agent.reasoning_effort_invalid"
  | "configuration.agent.role_invalid"
  | "configuration.agents.exactly_two"
  | "configuration.agents_required"
  | "configuration.file_invalid"
  | "configuration.invalid"
  | "configuration.not_tracked"
  | "configuration.version_unsupported"
  | "configuration.writer.exactly_one"
  | "repository.not_git";

export interface StartupValidationError {
  code: StartupValidationCode;
  message: string;
  path?: string;
}

export interface RepositoryIdentity {
  id: string;
  commonDirectory: string;
}

export type StartMeshResult =
  | {
      status: "rejected";
      errors: StartupValidationError[];
    }
  | {
      status: "validated";
      repository: RepositoryIdentity;
      configuration: MeshConfiguration;
    };

export interface Supervisor {
  start(request: StartMeshRequest): Promise<StartMeshResult>;
}

export function createSupervisor(): Supervisor {
  return {
    async start(request): Promise<StartMeshResult> {
      const repository = await resolveRepositoryIdentity(request.cwd);
      if (!repository) {
        return {
          status: "rejected",
          errors: [
            {
              code: "repository.not_git",
              message: "Startup requires a Git Repository.",
            },
          ],
        };
      }

      const configurationResult = await loadMeshConfiguration(
        request.cwd,
        request.configurationPath,
      );
      if (!configurationResult.ok) {
        return { status: "rejected", errors: configurationResult.errors };
      }

      return {
        status: "validated",
        repository,
        configuration: configurationResult.configuration,
      };
    },
  };
}

async function loadMeshConfiguration(
  cwd: string,
  configurationPath: string,
): Promise<ConfigurationValidationResult> {
  const absolutePath = resolve(cwd, configurationPath);
  const tracked = Bun.spawn(["git", "ls-files", "--error-unmatch", "--", absolutePath], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  if ((await tracked.exited) !== 0) {
    return invalid(
      "configuration.not_tracked",
      "Mesh Configuration must be tracked by Git.",
      absolutePath,
    );
  }

  let configuration: unknown;
  try {
    configuration = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch {
    return invalid(
      "configuration.file_invalid",
      "Mesh Configuration must be readable JSON.",
      absolutePath,
    );
  }
  return validateMeshConfiguration(configuration);
}

async function resolveRepositoryIdentity(cwd: string): Promise<RepositoryIdentity | undefined> {
  const command = Bun.spawn(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    command.exited,
    new Response(command.stdout).text(),
  ]);
  if (exitCode !== 0) {
    return undefined;
  }

  const commonDirectory = await realpath(stdout.trim());
  return {
    id: createHash("sha256").update(commonDirectory).digest("hex"),
    commonDirectory,
  };
}

type ConfigurationValidationResult =
  | { ok: true; configuration: MeshConfiguration }
  | { ok: false; errors: StartupValidationError[] };

function validateMeshConfiguration(configuration: unknown): ConfigurationValidationResult {
  if (!isRecord(configuration)) {
    return invalid("configuration.invalid", "Mesh Configuration must be an object.");
  }
  if (configuration.version !== 1) {
    return invalid(
      "configuration.version_unsupported",
      "Mesh Configuration version must be 1.",
      "version",
    );
  }
  if (!Array.isArray(configuration.agents)) {
    return invalid(
      "configuration.agents_required",
      "Mesh Configuration agents must be an array.",
      "agents",
    );
  }

  const errors: StartupValidationError[] = [];
  if (configuration.agents.length !== 2) {
    errors.push({
      code: "configuration.agents.exactly_two",
      message: "Mesh Configuration must declare exactly two Agents.",
      path: "agents",
    });
  }

  const seenNames = new Set<string>();
  for (const [index, candidate] of configuration.agents.entries()) {
    if (
      !isRecord(candidate) ||
      typeof candidate.name !== "string" ||
      candidate.name.trim() === ""
    ) {
      continue;
    }
    if (seenNames.has(candidate.name)) {
      errors.push({
        code: "configuration.agent.name_duplicate",
        message: `Agent Name "${candidate.name}" must be unique.`,
        path: `agents[${index}].name`,
      });
    }
    seenNames.add(candidate.name);
  }

  const writerCount = configuration.agents.filter(
    (candidate) => isRecord(candidate) && candidate.role === "writer",
  ).length;
  const adviserCount = configuration.agents.filter(
    (candidate) => isRecord(candidate) && candidate.role === "adviser",
  ).length;
  if (writerCount !== 1) {
    errors.push({
      code: "configuration.writer.exactly_one",
      message: "Mesh Configuration must declare exactly one Writer.",
      path: "agents",
    });
  }
  if (adviserCount !== 1) {
    errors.push({
      code: "configuration.adviser.exactly_one",
      message: "Mesh Configuration must declare exactly one Adviser.",
      path: "agents",
    });
  }

  for (const [index, candidate] of configuration.agents.entries()) {
    validateAgent(candidate, index, errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, configuration: configuration as unknown as MeshConfiguration };
}

function validateAgent(candidate: unknown, index: number, errors: StartupValidationError[]): void {
  const prefix = `agents[${index}]`;
  if (!isRecord(candidate)) {
    errors.push({
      code: "configuration.agent.invalid",
      message: "Agent Configuration must be an object.",
      path: prefix,
    });
    return;
  }

  requireNonEmptyString(candidate.name, `${prefix}.name`, "name", errors);
  if (candidate.role !== "writer" && candidate.role !== "adviser") {
    errors.push({
      code: "configuration.agent.role_invalid",
      message: "Agent role must be writer or adviser.",
      path: `${prefix}.role`,
    });
  }
  requireNonEmptyString(candidate.objective, `${prefix}.objective`, "objective", errors);

  if (!isRecord(candidate.model)) {
    errors.push({
      code: "configuration.agent.model_required",
      message: "Agent model options must be an object.",
      path: `${prefix}.model`,
    });
  } else {
    requireNonEmptyString(candidate.model.name, `${prefix}.model.name`, "model_name", errors);
    if (
      candidate.model.reasoningEffort !== undefined &&
      (typeof candidate.model.reasoningEffort !== "string" ||
        candidate.model.reasoningEffort.trim() === "")
    ) {
      errors.push({
        code: "configuration.agent.reasoning_effort_invalid",
        message: "Agent reasoning effort must be a non-empty string when provided.",
        path: `${prefix}.model.reasoningEffort`,
      });
    }
  }

  requireNonEmptyString(
    candidate.trustedInstructions,
    `${prefix}.trustedInstructions`,
    "instructions",
    errors,
  );
  if (!Array.isArray(candidate.capabilities)) {
    errors.push({
      code: "configuration.agent.capabilities_required",
      message: "Agent Capabilities must be an array.",
      path: `${prefix}.capabilities`,
    });
  } else {
    if (candidate.capabilities.length === 0) {
      errors.push({
        code: "configuration.agent.capability_required",
        message: "Agent Configuration must declare at least one descriptive Capability.",
        path: `${prefix}.capabilities`,
      });
    }
    for (const [capabilityIndex, capability] of candidate.capabilities.entries()) {
      if (typeof capability !== "string" || capability.trim() === "") {
        errors.push({
          code: "configuration.agent.capability_invalid",
          message: "Every Agent Capability must be a non-empty string.",
          path: `${prefix}.capabilities[${capabilityIndex}]`,
        });
      }
    }
  }
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  field: "name" | "objective" | "model_name" | "instructions",
  errors: StartupValidationError[],
): void {
  if (typeof value === "string" && value.trim() !== "") {
    return;
  }
  const messages = {
    name: "Agent Name must be a non-empty string.",
    objective: "Agent Objective must be a non-empty string.",
    model_name: "Agent model name must be a non-empty string.",
    instructions: "Agent trusted instructions must be a non-empty string.",
  } as const;
  errors.push({
    code: `configuration.agent.${field}_required`,
    message: messages[field],
    path,
  });
}

function invalid(
  code: StartupValidationCode,
  message: string,
  path?: string,
): ConfigurationValidationResult {
  return {
    ok: false,
    errors: [{ code, message, ...(path === undefined ? {} : { path }) }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
