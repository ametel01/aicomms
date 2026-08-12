import { randomBytes, randomUUID } from "node:crypto";
import {
  type AppServerAdapter,
  sandboxForRole,
  unavailableAppServerAdapter,
} from "./app-server.ts";
import {
  type AgentConfiguration,
  type AgentLifecycleStatus,
  type AgentModelOptions,
  type AgentRole,
  type MeshConfiguration,
  type PublicAgent,
  type RepositoryIdentity,
  resolveRepositoryIdentity,
  type SupervisorError,
  type SupervisorErrorCode,
  validateStartup,
} from "./startup-validation.ts";
import { type MeshRun, TranscriptStore } from "./transcript-store.ts";

export type {
  AgentConfiguration,
  AgentLifecycleStatus,
  AgentModelOptions,
  AgentRole,
  MeshConfiguration,
  PublicAgent,
  RepositoryIdentity,
  SupervisorError,
  SupervisorErrorCode,
};

export interface StartMeshRequest {
  cwd: string;
  configurationPath: string;
}

export type StartMeshResult =
  | { status: "rejected"; errors: SupervisorError[] }
  | { status: "failed"; meshRunId: string; error: SupervisorError }
  | { status: "running"; meshRun: MeshRun };

export interface StopMeshResult {
  status: "stopped";
  meshRunId: string;
}

export interface Supervisor {
  start(request: StartMeshRequest): Promise<StartMeshResult>;
  stop(request: { meshRunId: string }): Promise<StopMeshResult>;
  inspectMeshRun(request: { cwd: string; meshRunId: string }): Promise<MeshRun | undefined>;
}

export interface SupervisorOptions {
  appServer?: AppServerAdapter;
  generateOpaqueValue?: () => string;
}

interface ActiveMeshRun {
  id: string;
  appServer: AppServerAdapter;
  store: TranscriptStore;
}

export function createSupervisor(options: SupervisorOptions = {}): Supervisor {
  const appServer = options.appServer ?? unavailableAppServerAdapter();
  const generateOpaqueValue = options.generateOpaqueValue ?? defaultOpaqueValueGenerator();
  let active: ActiveMeshRun | undefined;

  return {
    async start(request): Promise<StartMeshResult> {
      if (active) {
        return {
          status: "rejected",
          errors: [
            {
              code: "startup.already_running",
              message: "This Supervisor already owns an active Mesh Run.",
            },
          ],
        };
      }

      const validation = await validateStartup(request.cwd, request.configurationPath);
      if (!validation.ok) {
        return { status: "rejected", errors: validation.errors };
      }

      const meshRunId = generateOpaqueValue();
      const agentRuntime = validation.configuration.agents.map((configuration) => ({
        configuration,
        agent: publicAgent(configuration, generateOpaqueValue()),
        credential: generateOpaqueValue(),
      }));
      let store: TranscriptStore | undefined;
      let meshRunRecorded = false;

      try {
        store = await TranscriptStore.open(validation.repository.rootDirectory);
        store.createMeshRun({
          id: meshRunId,
          repositoryId: validation.repository.id,
          status: "starting",
          agents: agentRuntime.map(({ agent }) => agent),
        });
        meshRunRecorded = true;
        await appServer.initialize();
        for (const runtime of agentRuntime) {
          const thread = await appServer.startThread({
            ...runtime.configuration,
            agentId: runtime.agent.id,
            agentCredential: runtime.credential,
            sandbox: sandboxForRole(runtime.configuration.role),
          });
          if (!thread.mcpReady) {
            throw new Error(`MCP connection for Agent ${runtime.agent.name} is not ready.`);
          }
          runtime.agent.threadId = thread.threadId;
        }

        const writer = agentRuntime.find(({ agent }) => agent.role === "writer");
        if (!writer?.agent.threadId) {
          throw new Error("Writer thread is not ready.");
        }
        writer.agent.status = "working";
        const adviser = agentRuntime.find(({ agent }) => agent.role === "adviser");
        if (adviser) {
          adviser.agent.status = "idle";
        }
        const agents = agentRuntime.map(({ agent }) => agent);
        await appServer.startObjective({
          threadId: writer.agent.threadId,
          objective: writer.agent.objective,
          roster: agents,
        });
        store.markRunning(meshRunId, agents);
        const meshRun = store.inspectMeshRun(meshRunId);
        if (!meshRun) {
          throw new Error("Started Mesh Run could not be read from the Transcript.");
        }
        active = { id: meshRunId, appServer, store };
        return { status: "running", meshRun };
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "Unknown startup prerequisite failure.";
        if (store && meshRunRecorded) {
          try {
            store.markFailed(meshRunId, message);
          } catch {
            // Preserve the original prerequisite failure when the Transcript is also unhealthy.
          }
        }
        await closeAfterFailedStart(appServer, store);
        return {
          status: "failed",
          meshRunId,
          error: {
            code: "startup.prerequisite_failed",
            message,
          },
        };
      }
    },

    async stop(request): Promise<StopMeshResult> {
      if (!active || active.id !== request.meshRunId) {
        throw new Error(`Mesh Run ${request.meshRunId} is not active.`);
      }
      const stopping = active;
      try {
        await stopping.appServer.close();
        stopping.store.markStopped(stopping.id);
        return { status: "stopped", meshRunId: request.meshRunId };
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "Unknown resource closure failure.";
        stopping.store.markFailed(stopping.id, message);
        throw cause;
      } finally {
        stopping.store.close();
        active = undefined;
      }
    },

    async inspectMeshRun(request): Promise<MeshRun | undefined> {
      const repository = await resolveRepositoryIdentity(request.cwd);
      if (!repository) {
        return undefined;
      }
      const store = await TranscriptStore.open(repository.rootDirectory);
      try {
        return store.inspectMeshRun(request.meshRunId);
      } finally {
        store.close();
      }
    },
  };
}

function publicAgent(configuration: AgentConfiguration, id: string): PublicAgent {
  return {
    id,
    name: configuration.name,
    role: configuration.role,
    objective: configuration.objective,
    capabilities: configuration.capabilities,
    status: "starting",
  };
}

function defaultOpaqueValueGenerator(): () => string {
  let nextIsCredential = false;
  return () => {
    nextIsCredential = !nextIsCredential;
    return nextIsCredential ? randomUUID() : randomBytes(32).toString("base64url");
  };
}

async function closeAfterFailedStart(
  appServer: AppServerAdapter,
  store: TranscriptStore | undefined,
): Promise<void> {
  try {
    await appServer.close();
  } catch {
    // Startup already failed; cleanup errors must not replace the explicit primary failure.
  }
  try {
    store?.close();
  } catch {
    // Startup already failed; cleanup errors must not replace the explicit primary failure.
  }
}
