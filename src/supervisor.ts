import { randomBytes, randomUUID } from "node:crypto";
import {
  type AppServerAdapter,
  sandboxForRole,
  unavailableAppServerAdapter,
} from "./app-server.ts";
import { DiscoveryServer } from "./discovery-server.ts";
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
  discoveryServer: DiscoveryServer;
  store: TranscriptStore;
  unsubscribeFromThreadStatus: () => void;
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
      let discoveryServer: DiscoveryServer | undefined;
      let unsubscribeFromThreadStatus: (() => void) | undefined;
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
        const agents = agentRuntime.map(({ agent }) => agent);
        discoveryServer = await DiscoveryServer.start(
          validation.repository.rootDirectory,
          agentRuntime.map(({ agent, credential }) => ({ agentId: agent.id, credential })),
          agents,
        );
        await appServer.initialize();
        unsubscribeFromThreadStatus = appServer.onThreadStatusChanged((threadId, status) => {
          const agent = agents.find((candidate) => candidate.threadId === threadId);
          if (!agent) {
            return;
          }
          agent.status = lifecycleStatus(status);
          store?.updateAgentStatus(meshRunId, agent);
        });
        for (const runtime of agentRuntime) {
          const thread = await appServer.startThread({
            ...runtime.configuration,
            agentId: runtime.agent.id,
            agentCredential: runtime.credential,
            sandbox: sandboxForRole(runtime.configuration.role),
            mcpServer: discoveryServer.launchFor(runtime.agent.id, runtime.credential),
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
        active = {
          id: meshRunId,
          appServer,
          discoveryServer,
          store,
          unsubscribeFromThreadStatus,
        };
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
        unsubscribeFromThreadStatus?.();
        await closeAfterFailedStart(appServer, discoveryServer, store);
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
      let closeFailure: unknown;
      try {
        stopping.unsubscribeFromThreadStatus();
        try {
          await stopping.appServer.close();
        } catch (cause) {
          closeFailure = cause;
        }
        try {
          await stopping.discoveryServer.close();
        } catch (cause) {
          closeFailure ??= cause;
        }
        if (closeFailure) {
          throw closeFailure;
        }
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
  discoveryServer: DiscoveryServer | undefined,
  store: TranscriptStore | undefined,
): Promise<void> {
  try {
    await appServer.close();
  } catch {
    // Startup already failed; cleanup errors must not replace the explicit primary failure.
  }
  try {
    await discoveryServer?.close();
  } catch {
    // Startup already failed; cleanup errors must not replace the explicit primary failure.
  }
  try {
    store?.close();
  } catch {
    // Startup already failed; cleanup errors must not replace the explicit primary failure.
  }
}

function lifecycleStatus(
  status: "active" | "idle" | "closed" | "system-error",
): AgentLifecycleStatus {
  return status === "active" ? "working" : status === "idle" ? "idle" : "stopped";
}
