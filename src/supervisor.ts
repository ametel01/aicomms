import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, posix } from "node:path";
import {
  type AppServerAdapter,
  HandlingStartError,
  type OperatorWaitRequest,
  type OperatorWaitResponse,
  sandboxForRole,
  unavailableAppServerAdapter,
} from "./app-server.ts";
import { DiscoveryServer, type SendNotificationInput } from "./discovery-server.ts";
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
import {
  type ConversationLimits,
  type ConversationSnapshot,
  type EvidenceSnapshot,
  type MeshRun,
  type Message,
  type NotificationContext,
  type OperatorRequest,
  type StructuredTranscriptEvent,
  type SupervisorNotice,
  TranscriptStore,
} from "./transcript-store.ts";

export type {
  AgentConfiguration,
  AgentLifecycleStatus,
  AgentModelOptions,
  AgentRole,
  ConversationLimits,
  MeshConfiguration,
  OperatorRequest,
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
  | { status: "running"; meshRun: MeshRun; operatorCredential: string };

export interface StopMeshResult {
  status: "stopped";
  meshRunId: string;
}

export interface Supervisor {
  start(request: StartMeshRequest): Promise<StartMeshResult>;
  stop(request: { meshRunId: string }): Promise<StopMeshResult>;
  inspectMeshRun(request: { cwd: string; meshRunId: string }): Promise<MeshRun | undefined>;
  inspectConversation(request: {
    cwd: string;
    conversationId: string;
  }): Promise<ConversationSnapshot | undefined>;
  inspectEvidence(request: { cwd: string; meshRunId?: string }): Promise<EvidenceSnapshot>;
  listStructuredEvents(request: {
    cwd: string;
    meshRunId?: string;
    afterSequence?: number;
  }): Promise<StructuredTranscriptEvent[]>;
  purgeEvidence(request: { cwd: string; confirmed: boolean }): Promise<{ status: "purged" }>;
  listOperatorRequests(request: { cwd: string; meshRunId?: string }): Promise<OperatorRequest[]>;
  respondToOperatorRequest(request: {
    meshRunId: string;
    requestId: string;
    response: OperatorWaitResponse;
  }): Promise<OperatorRequest>;
  cancelConversation(request: {
    meshRunId: string;
    conversationId: string;
  }): Promise<CancelConversationResult>;
}

export interface CancelConversationResult {
  status: "cancelled";
  conversationId: string;
  effectsReversible: false;
  warning: string;
}

export interface SupervisorOptions {
  appServer?: AppServerAdapter;
  generateOpaqueValue?: () => string;
  now?: () => number;
  scheduleDeadline?: (callback: () => void, delayMilliseconds: number) => () => void;
  conversationLimits?: Partial<ConversationLimits>;
  operatorCredential?: string;
}

interface ActiveMeshRun {
  id: string;
  appServer: AppServerAdapter;
  discoveryServer: DiscoveryServer;
  store: TranscriptStore;
  unsubscribeFromThreadStatus: () => void;
  unsubscribeFromOperatorWaits: () => void;
  unsubscribeFromUnexpectedExit: () => void;
  cancelDeadlines: () => void;
  scheduler: DeliveryScheduler;
}

const DEFAULT_CONVERSATION_LIMITS: ConversationLimits = {
  agentTriggeredMessages: 4,
  totalMessages: 8,
  elapsedMilliseconds: 5 * 60 * 1000,
};

function normalizedConversationLimits(
  configured: Partial<ConversationLimits> | undefined,
): ConversationLimits {
  const limits = { ...DEFAULT_CONVERSATION_LIMITS, ...configured };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Conversation limit ${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

export function createSupervisor(options: SupervisorOptions = {}): Supervisor {
  const appServer = options.appServer ?? unavailableAppServerAdapter();
  const generateOpaqueValue = options.generateOpaqueValue ?? defaultOpaqueValueGenerator();
  const now = options.now ?? Date.now;
  const scheduleDeadline = options.scheduleDeadline ?? defaultDeadlineScheduler;
  const conversationLimits = normalizedConversationLimits(options.conversationLimits);
  const configuredOperatorCredential = options.operatorCredential;
  let pendingFailureCleanup: Promise<void> | undefined;
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
      await pendingFailureCleanup;
      pendingFailureCleanup = undefined;

      const validation = await validateStartup(request.cwd, request.configurationPath);
      if (!validation.ok) {
        return { status: "rejected", errors: validation.errors };
      }

      const meshRunId = generateOpaqueValue();
      const operatorCredential =
        configuredOperatorCredential ?? randomBytes(32).toString("base64url");
      const agentRuntime = validation.configuration.agents.map((configuration) => ({
        configuration,
        agent: publicAgent(configuration, generateOpaqueValue()),
        credential: generateOpaqueValue(),
      }));
      let store: TranscriptStore | undefined;
      let discoveryServer: DiscoveryServer | undefined;
      let unsubscribeFromThreadStatus: (() => void) | undefined;
      let unsubscribeFromOperatorWaits: (() => void) | undefined;
      let unsubscribeFromUnexpectedExit: (() => void) | undefined;
      let startupUnexpectedExitReason: string | undefined;
      let meshRunRecorded = false;
      const scheduler: DeliveryScheduler = {
        queues: new Map(),
        delivering: new Set(),
        queuedMessageIds: new Set(),
        generateOpaqueValue,
        agents: [],
        noticeQueues: new Map(),
        meshRunId,
        handlingConversations: new Map(),
        objectiveAgentIds: new Set(),
        conversationDeadlineCancellations: new Map(),
        conversationDeadlines: new Map(),
        now,
        scheduleDeadline,
        limits: conversationLimits,
        activeHandlings: new Map(),
        startingHandlings: new Map(),
        pendingWaitIdsByConversation: new Map(),
        stopped: false,
      };

      try {
        store = await TranscriptStore.open(validation.repository.rootDirectory);
        store.failStaleMeshRuns(validation.repository.id);
        store.createMeshRun({
          id: meshRunId,
          repositoryId: validation.repository.id,
          status: "starting",
          agents: agentRuntime.map(({ agent }) => agent),
        });
        meshRunRecorded = true;
        const agents = agentRuntime.map(({ agent }) => agent);
        scheduler.agents = agents;
        const acceptPeerMessage = async (
          kind: "notification" | "question",
          callerAgentId: string,
          input: SendNotificationInput,
        ): Promise<string> => {
          if (scheduler.stopped) {
            throw new Error("Mesh Run is stopped.");
          }
          if (!store) {
            throw new Error("Transcript is unavailable.");
          }
          const transcript = store;
          const validatedInput = validateNotificationInput(input);
          const inheritedConversation = scheduler.handlingConversations.get(callerAgentId);
          if (!inheritedConversation && !scheduler.objectiveAgentIds.has(callerAgentId)) {
            throw new Error(
              "Only the Writer's initial Objective or an active Message Handling may start peer communication.",
            );
          }
          const recipient = agents.find((agent) => agent.id === input.recipientAgentId);
          if (!recipient?.threadId) {
            throw new Error("Recipient Agent is unavailable.");
          }
          enforceQueueCapacity(scheduler, recipient);
          const message = peerMessage(
            kind,
            generateOpaqueValue(),
            inheritedConversation ?? generateOpaqueValue(),
            callerAgentId,
            validatedInput.recipientAgentId,
            validatedInput.body,
            validatedInput.context,
            new Date(scheduler.now()).toISOString(),
          );
          const acceptance = transcript.recordAgentMessage(
            meshRunId,
            message,
            inheritedConversation === undefined,
            scheduler.limits,
            inheritedConversation
              ? effectiveConversationNow(scheduler, inheritedConversation)
              : scheduler.now(),
          );
          if (!acceptance.accepted) {
            if (acceptance.conversationStatus) {
              cancelConversationDeadline(scheduler, message.conversationId);
              purgeTerminalConversationFromScheduler(scheduler, transcript, message.conversationId);
              scheduleAllDeliveries(scheduler, appServer, transcript);
            }
            throw new Error(acceptance.reason);
          }
          if (acceptance.newConversation) {
            scheduleConversationDeadline(scheduler, appServer, transcript, message);
          }
          enqueueNotification(scheduler, appServer, transcript, meshRunId, recipient, message);
          return message.id;
        };
        discoveryServer = await DiscoveryServer.start(
          validation.repository.rootDirectory,
          agentRuntime.map(({ agent, credential }) => ({ agentId: agent.id, credential })),
          operatorCredential,
          agents,
          {
            sendNotification: (callerAgentId, input) =>
              acceptPeerMessage("notification", callerAgentId, input),
            askQuestion: (callerAgentId, input) =>
              acceptPeerMessage("question", callerAgentId, input),
            listOperatorRequests: (requestedMeshRunId) =>
              store?.listOperatorRequests(requestedMeshRunId) ?? [],
            respondToOperatorRequest: (requestedMeshRunId, requestId, response) => {
              if (!store) {
                throw new Error("Transcript is unavailable.");
              }
              return respondToOperatorRequestCore(
                meshRunId,
                appServer,
                store,
                scheduler,
                requestedMeshRunId,
                requestId,
                response,
              );
            },
            cancelConversation: (requestedMeshRunId, conversationId) => {
              if (!store) {
                throw new Error("Transcript is unavailable.");
              }
              return cancelConversationCore(
                meshRunId,
                appServer,
                store,
                scheduler,
                requestedMeshRunId,
                conversationId,
              );
            },
          },
        );
        await appServer.initialize();
        unsubscribeFromThreadStatus = appServer.onThreadStatusChanged((threadId, status) => {
          const agent = agents.find((candidate) => candidate.threadId === threadId);
          if (!agent) {
            return;
          }
          agent.status = lifecycleStatus(status);
          if (agent.status !== "working") {
            scheduler.objectiveAgentIds.delete(agent.id);
          }
          store?.updateAgentStatus(meshRunId, agent);
          if ((agent.status === "idle" || agent.status === "unloaded") && store) {
            scheduleDelivery(scheduler, appServer, store, meshRunId, agent);
          }
        });
        unsubscribeFromOperatorWaits = appServer.onOperatorWait((operatorWait) => {
          if (store) {
            recordOperatorWait(scheduler, store, meshRunId, operatorWait);
          }
        });
        unsubscribeFromUnexpectedExit = appServer.onUnexpectedExit((reason) => {
          const failing = active;
          if (!failing) {
            startupUnexpectedExitReason = `app_server_lost: ${reason}`;
            scheduler.stopped = true;
            return;
          }
          if (failing.id !== meshRunId) {
            return;
          }
          active = undefined;
          failing.scheduler.stopped = true;
          failing.unsubscribeFromThreadStatus();
          failing.unsubscribeFromOperatorWaits();
          failing.unsubscribeFromUnexpectedExit();
          failing.cancelDeadlines();
          failing.store.failMeshRunWithoutReplay(meshRunId, `app_server_lost: ${reason}`);
          for (const agent of failing.scheduler.agents) {
            agent.status = "stopped";
          }
          failing.scheduler.queues.clear();
          failing.scheduler.noticeQueues.clear();
          failing.scheduler.queuedMessageIds.clear();
          pendingFailureCleanup = failing.discoveryServer
            .close()
            .catch(() => {})
            .finally(() => failing.store.close());
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
          if (startupUnexpectedExitReason) {
            throw new Error(startupUnexpectedExitReason);
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
        scheduler.objectiveAgentIds.add(writer.agent.id);
        await appServer.startObjective({
          threadId: writer.agent.threadId,
          objective: writer.agent.objective,
          roster: agents,
        });
        if (startupUnexpectedExitReason) {
          throw new Error(startupUnexpectedExitReason);
        }
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
          unsubscribeFromOperatorWaits,
          unsubscribeFromUnexpectedExit,
          cancelDeadlines: () => cancelAllConversationDeadlines(scheduler),
          scheduler,
        };
        return { status: "running", meshRun, operatorCredential };
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "Unknown startup prerequisite failure.";
        if (store && meshRunRecorded) {
          try {
            if (startupUnexpectedExitReason) {
              store.failMeshRunWithoutReplay(meshRunId, startupUnexpectedExitReason);
            } else {
              store.markFailed(meshRunId, message);
            }
          } catch {
            // Preserve the original prerequisite failure when the Transcript is also unhealthy.
          }
        }
        unsubscribeFromThreadStatus?.();
        unsubscribeFromOperatorWaits?.();
        unsubscribeFromUnexpectedExit?.();
        cancelAllConversationDeadlines(scheduler);
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
        stopping.unsubscribeFromOperatorWaits();
        stopping.unsubscribeFromUnexpectedExit();
        stopping.cancelDeadlines();
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

    async inspectConversation(request): Promise<ConversationSnapshot | undefined> {
      const repository = await resolveRepositoryIdentity(request.cwd);
      if (!repository) {
        return undefined;
      }
      const store = await TranscriptStore.open(repository.rootDirectory);
      try {
        return store.inspectConversation(request.conversationId);
      } finally {
        store.close();
      }
    },

    async inspectEvidence(request): Promise<EvidenceSnapshot> {
      const repository = await resolveRepositoryIdentity(request.cwd);
      if (!repository) {
        throw new Error("Evidence inspection requires a Git Repository.");
      }
      const store = await TranscriptStore.open(repository.rootDirectory);
      try {
        return store.inspectEvidence(request.meshRunId);
      } finally {
        store.close();
      }
    },

    async listStructuredEvents(request): Promise<StructuredTranscriptEvent[]> {
      const repository = await resolveRepositoryIdentity(request.cwd);
      if (!repository) {
        throw new Error("Structured log inspection requires a Git Repository.");
      }
      const store = await TranscriptStore.open(repository.rootDirectory);
      try {
        return store.listStructuredEvents(request.meshRunId, request.afterSequence ?? 0);
      } finally {
        store.close();
      }
    },

    async purgeEvidence(request): Promise<{ status: "purged" }> {
      if (!request.confirmed) {
        throw new Error("Evidence purge requires explicit confirmation.");
      }
      const repository = await resolveRepositoryIdentity(request.cwd);
      if (!repository) {
        throw new Error("Evidence purge requires a Git Repository.");
      }
      if (active) {
        throw new Error("Evidence cannot be purged while this Supervisor is active.");
      }
      const stateDirectory = join(repository.rootDirectory, ".codex-meshd");
      if (await isSupervisorSocketLive(join(stateDirectory, "supervisor.sock"))) {
        throw new Error("Evidence cannot be purged while a Supervisor is active.");
      }
      await rm(stateDirectory, { recursive: true, force: true });
      return { status: "purged" };
    },

    async listOperatorRequests(request): Promise<OperatorRequest[]> {
      const repository = await resolveRepositoryIdentity(request.cwd);
      if (!repository) {
        return [];
      }
      const store = await TranscriptStore.open(repository.rootDirectory);
      try {
        return store.listOperatorRequests(request.meshRunId);
      } finally {
        store.close();
      }
    },

    async respondToOperatorRequest(request): Promise<OperatorRequest> {
      if (!active || active.id !== request.meshRunId) {
        throw new Error(`Mesh Run ${request.meshRunId} is not active.`);
      }
      return respondToOperatorRequestCore(
        active.id,
        active.appServer,
        active.store,
        active.scheduler,
        request.meshRunId,
        request.requestId,
        request.response,
      );
    },

    async cancelConversation(request): Promise<CancelConversationResult> {
      if (!active || active.id !== request.meshRunId) {
        throw new Error(`Mesh Run ${request.meshRunId} is not active.`);
      }
      return cancelConversationCore(
        active.id,
        active.appServer,
        active.store,
        active.scheduler,
        request.meshRunId,
        request.conversationId,
      );
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
  status: "active" | "idle" | "unloaded" | "closed" | "system-error",
): AgentLifecycleStatus {
  return status === "active"
    ? "working"
    : status === "idle"
      ? "idle"
      : status === "unloaded"
        ? "unloaded"
        : "stopped";
}

interface DeliveryScheduler {
  queues: Map<string, Message[]>;
  delivering: Set<string>;
  queuedMessageIds: Set<string>;
  generateOpaqueValue: () => string;
  agents: PublicAgent[];
  noticeQueues: Map<string, SupervisorNotice[]>;
  meshRunId: string;
  handlingConversations: Map<string, string>;
  objectiveAgentIds: Set<string>;
  conversationDeadlineCancellations: Map<string, () => void>;
  conversationDeadlines: Map<string, ConversationDeadlineState>;
  now: () => number;
  scheduleDeadline: (callback: () => void, delayMilliseconds: number) => () => void;
  limits: ConversationLimits;
  activeHandlings: Map<string, ActiveHandling>;
  startingHandlings: Map<string, Message>;
  pendingWaitIdsByConversation: Map<string, Set<string>>;
  stopped: boolean;
}

interface ConversationDeadlineState {
  rootMessage: Message;
  elapsedMilliseconds: number;
  runningSince: number;
  paused: boolean;
}

interface ActiveHandling {
  threadId: string;
  turnId: string;
  message: Message;
}

async function isSupervisorSocketLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const settle = (live: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(live);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", (cause: NodeJS.ErrnoException) =>
      settle(cause.code !== "ENOENT" && cause.code !== "ECONNREFUSED"),
    );
    socket.setTimeout(250, () => settle(true));
  });
}

const MAX_QUEUED_MESSAGES_PER_AGENT = 32;
const MAX_QUEUED_MESSAGES_PER_MESH = 128;

function defaultDeadlineScheduler(callback: () => void, delayMilliseconds: number): () => void {
  const timeout = setTimeout(callback, delayMilliseconds);
  timeout.unref?.();
  return () => clearTimeout(timeout);
}

function scheduleConversationDeadline(
  scheduler: DeliveryScheduler,
  appServer: AppServerAdapter,
  store: TranscriptStore,
  rootMessage: Message,
): void {
  scheduler.conversationDeadlines.set(rootMessage.conversationId, {
    rootMessage,
    elapsedMilliseconds: 0,
    runningSince: scheduler.now(),
    paused: false,
  });
  armConversationDeadline(scheduler, appServer, store, rootMessage.conversationId);
}

function armConversationDeadline(
  scheduler: DeliveryScheduler,
  appServer: AppServerAdapter,
  store: TranscriptStore,
  conversationId: string,
): void {
  const state = scheduler.conversationDeadlines.get(conversationId);
  if (!state || state.paused) {
    return;
  }
  const remaining = Math.max(0, scheduler.limits.elapsedMilliseconds - state.elapsedMilliseconds);
  const cancel = scheduler.scheduleDeadline(() => {
    scheduler.conversationDeadlineCancellations.delete(conversationId);
    const effectiveNow = effectiveConversationNow(scheduler, conversationId);
    if (!store.expireConversation(conversationId, effectiveNow, scheduler.limits)) {
      state.elapsedMilliseconds = effectiveNow - Date.parse(state.rootMessage.createdAt);
      state.runningSince = scheduler.now();
      armConversationDeadline(scheduler, appServer, store, conversationId);
      return;
    }
    scheduler.conversationDeadlines.delete(conversationId);
    queueSupervisorNotice(
      scheduler,
      appServer,
      store,
      state.rootMessage,
      "Conversation deadline elapsed.",
    );
    purgeTerminalConversationFromScheduler(scheduler, store, conversationId);
    scheduleAllDeliveries(scheduler, appServer, store);
  }, remaining);
  scheduler.conversationDeadlineCancellations.set(conversationId, cancel);
}

function effectiveConversationNow(scheduler: DeliveryScheduler, conversationId: string): number {
  const state = scheduler.conversationDeadlines.get(conversationId);
  if (!state) {
    return scheduler.now();
  }
  const elapsed =
    state.elapsedMilliseconds + (state.paused ? 0 : scheduler.now() - state.runningSince);
  return Date.parse(state.rootMessage.createdAt) + elapsed;
}

function pauseConversationDeadline(scheduler: DeliveryScheduler, conversationId: string): void {
  const state = scheduler.conversationDeadlines.get(conversationId);
  if (!state || state.paused) {
    return;
  }
  state.elapsedMilliseconds += scheduler.now() - state.runningSince;
  state.paused = true;
  scheduler.conversationDeadlineCancellations.get(conversationId)?.();
  scheduler.conversationDeadlineCancellations.delete(conversationId);
}

function resolveConversationWait(
  scheduler: DeliveryScheduler,
  appServer: AppServerAdapter,
  store: TranscriptStore,
  conversationId: string,
  requestId: string,
): void {
  const waits = scheduler.pendingWaitIdsByConversation.get(conversationId);
  waits?.delete(requestId);
  if (waits && waits.size > 0) {
    return;
  }
  scheduler.pendingWaitIdsByConversation.delete(conversationId);
  const state = scheduler.conversationDeadlines.get(conversationId);
  if (!state?.paused) {
    return;
  }
  state.paused = false;
  state.runningSince = scheduler.now();
  armConversationDeadline(scheduler, appServer, store, conversationId);
}

function restoreConversationWait(
  scheduler: DeliveryScheduler,
  conversationId: string,
  requestId: string,
): void {
  const waits = scheduler.pendingWaitIdsByConversation.get(conversationId) ?? new Set();
  scheduler.pendingWaitIdsByConversation.set(conversationId, waits);
  waits.add(requestId);
  pauseConversationDeadline(scheduler, conversationId);
}

function cancelConversationDeadline(scheduler: DeliveryScheduler, conversationId: string): void {
  scheduler.conversationDeadlineCancellations.get(conversationId)?.();
  scheduler.conversationDeadlineCancellations.delete(conversationId);
  scheduler.conversationDeadlines.delete(conversationId);
}

function cancelAllConversationDeadlines(scheduler: DeliveryScheduler): void {
  for (const cancel of scheduler.conversationDeadlineCancellations.values()) {
    cancel();
  }
  scheduler.conversationDeadlineCancellations.clear();
  scheduler.conversationDeadlines.clear();
}

function scheduleAllDeliveries(
  scheduler: DeliveryScheduler,
  appServer: AppServerAdapter,
  store: TranscriptStore,
): void {
  if (scheduler.stopped) {
    return;
  }
  for (const agent of scheduler.agents) {
    if (agent.status === "idle" || agent.status === "unloaded") {
      scheduleDelivery(scheduler, appServer, store, scheduler.meshRunId, agent);
    }
  }
}

function recordOperatorWait(
  scheduler: DeliveryScheduler,
  store: TranscriptStore,
  meshRunId: string,
  wait: OperatorWaitRequest,
): void {
  if (store.listOperatorRequests(meshRunId).some((request) => request.id === wait.id)) {
    return;
  }
  const handling = [...scheduler.activeHandlings.values()].find(
    (candidate) => candidate.threadId === wait.threadId && candidate.turnId === wait.turnId,
  );
  const startingMessage = scheduler.startingHandlings.get(wait.threadId);
  const conversationId = handling?.message.conversationId ?? startingMessage?.conversationId;
  const request: OperatorRequest = {
    id: wait.id,
    meshRunId,
    type: wait.type,
    threadId: wait.threadId,
    turnId: wait.turnId,
    prompt: wait.prompt,
    status: "pending",
    createdAt: new Date(scheduler.now()).toISOString(),
    ...(conversationId ? { conversationId } : {}),
  };
  store.recordOperatorRequest(request);
  if (!request.conversationId) {
    return;
  }
  const waits = scheduler.pendingWaitIdsByConversation.get(request.conversationId) ?? new Set();
  scheduler.pendingWaitIdsByConversation.set(request.conversationId, waits);
  waits.add(request.id);
  pauseConversationDeadline(scheduler, request.conversationId);
}

function validateOperatorResponse(request: OperatorRequest, response: OperatorWaitResponse): void {
  if (!response || typeof response !== "object" || request.type !== response.type) {
    throw new Error(`Operator Request ${request.id} requires a ${request.type} response.`);
  }
  if (
    request.type === "approval" &&
    (response.type !== "approval" ||
      (response.decision !== "approved" && response.decision !== "denied"))
  ) {
    throw new Error("Operator approval decision must be approved or denied.");
  }
  if (
    request.type === "input" &&
    (response.type !== "input" || typeof response.answer !== "string" || response.answer === "")
  ) {
    throw new Error("Operator input answer must be a non-empty string.");
  }
}

async function respondToOperatorRequestCore(
  activeMeshRunId: string,
  appServer: AppServerAdapter,
  store: TranscriptStore,
  scheduler: DeliveryScheduler,
  requestedMeshRunId: string,
  requestId: string,
  response: OperatorWaitResponse,
): Promise<OperatorRequest> {
  if (activeMeshRunId !== requestedMeshRunId) {
    throw new Error(`Mesh Run ${requestedMeshRunId} is not active.`);
  }
  const operatorRequest = store
    .listOperatorRequests(activeMeshRunId)
    .find((candidate) => candidate.id === requestId);
  if (operatorRequest?.status !== "pending" && operatorRequest?.status !== "delivery_failed") {
    throw new Error(`Operator Request ${requestId} is not awaiting a response.`);
  }
  if (operatorRequest.conversationId && !store.isConversationOpen(operatorRequest.conversationId)) {
    throw new Error(`Operator Request ${requestId} belongs to a terminal Conversation.`);
  }
  validateOperatorResponse(operatorRequest, response);
  const responding = store.beginOperatorRequestResponse(requestId, response);
  if (!responding) {
    throw new Error(`Operator Request ${requestId} could not begin response delivery.`);
  }
  if (responding.conversationId) {
    resolveConversationWait(scheduler, appServer, store, responding.conversationId, responding.id);
  }
  try {
    await appServer.respondToOperatorWait(requestId, response);
  } catch (cause) {
    if (scheduler.stopped) {
      throw cause;
    }
    store.failOperatorRequestResponse(requestId, failureMessage(cause));
    if (responding.conversationId) {
      restoreConversationWait(scheduler, responding.conversationId, responding.id);
    }
    throw cause;
  }
  if (scheduler.stopped) {
    throw new Error(`Mesh Run ${requestedMeshRunId} stopped during Operator response delivery.`);
  }
  const resolved = store.completeOperatorRequestResponse(requestId);
  if (!resolved) {
    throw new Error(`Operator Request ${requestId} could not complete response delivery.`);
  }
  return resolved;
}

async function cancelConversationCore(
  activeMeshRunId: string,
  appServer: AppServerAdapter,
  store: TranscriptStore,
  scheduler: DeliveryScheduler,
  requestedMeshRunId: string,
  conversationId: string,
): Promise<CancelConversationResult> {
  if (activeMeshRunId !== requestedMeshRunId) {
    throw new Error(`Mesh Run ${requestedMeshRunId} is not active.`);
  }
  if (!store.cancelConversation(requestedMeshRunId, conversationId)) {
    throw new Error(`Conversation ${conversationId} is not open.`);
  }
  cancelConversationDeadline(scheduler, conversationId);
  purgeTerminalConversationFromScheduler(scheduler, store, conversationId);
  scheduler.pendingWaitIdsByConversation.delete(conversationId);
  const handling = [...scheduler.activeHandlings.values()].find(
    (candidate) => candidate.message.conversationId === conversationId,
  );
  if (handling) {
    store.interruptHandling(handling.message, handling.turnId);
    try {
      await appServer.interruptTurn(handling.threadId, handling.turnId);
    } catch (cause) {
      if (!scheduler.stopped) {
        store.failInterruptedHandling(
          handling.message,
          handling.turnId,
          `Operator cancellation was recorded, but turn interruption failed: ${failureMessage(cause)}`,
        );
      }
    }
  }
  scheduleAllDeliveries(scheduler, appServer, store);
  return {
    status: "cancelled",
    conversationId,
    effectsReversible: false,
    warning: "Cancellation cannot undo completed filesystem or external effects.",
  };
}

function purgeTerminalConversationFromScheduler(
  scheduler: DeliveryScheduler,
  store: TranscriptStore,
  conversationId: string,
): void {
  for (const queue of scheduler.queues.values()) {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const message = queue[index];
      if (!message || message.conversationId !== conversationId) {
        continue;
      }
      queue.splice(index, 1);
      scheduler.queuedMessageIds.delete(message.id);
      store.cancelDelivery(message, "Delivery cancelled because its Conversation is terminal.");
    }
  }
}

function enforceQueueCapacity(scheduler: DeliveryScheduler, recipient: PublicAgent): void {
  const recipientQueue = scheduler.queues.get(recipient.id) ?? [];
  const willQueue =
    recipientQueue.length > 0 ||
    scheduler.delivering.has(recipient.id) ||
    recipient.status !== "idle";
  if (!willQueue) {
    return;
  }
  const recipientQueued = recipientQueue.filter((message) =>
    scheduler.queuedMessageIds.has(message.id),
  ).length;
  if (recipientQueued >= MAX_QUEUED_MESSAGES_PER_AGENT) {
    throw new Error("Recipient Agent queue limit of 32 Messages has been reached.");
  }
  if (scheduler.queuedMessageIds.size >= MAX_QUEUED_MESSAGES_PER_MESH) {
    throw new Error("Mesh queue limit of 128 Messages has been reached.");
  }
}

function enqueueNotification(
  scheduler: DeliveryScheduler,
  appServer: AppServerAdapter,
  store: TranscriptStore,
  meshRunId: string,
  recipient: PublicAgent,
  message: Message,
): void {
  const queue = scheduler.queues.get(recipient.id) ?? [];
  scheduler.queues.set(recipient.id, queue);
  queue.push(message);
  if (queue.length > 1 || scheduler.delivering.has(recipient.id) || recipient.status !== "idle") {
    store.markDeliveryQueued(message);
    scheduler.queuedMessageIds.add(message.id);
  }
  if (recipient.status === "idle" || recipient.status === "unloaded") {
    scheduleDelivery(scheduler, appServer, store, meshRunId, recipient);
  }
}

function scheduleDelivery(
  scheduler: DeliveryScheduler,
  appServer: AppServerAdapter,
  store: TranscriptStore,
  meshRunId: string,
  recipient: PublicAgent,
): void {
  if (scheduler.stopped) {
    return;
  }
  queueMicrotask(() => {
    void drainRecipientQueue(scheduler, appServer, store, meshRunId, recipient).catch(() => {});
  });
}

async function drainRecipientQueue(
  scheduler: DeliveryScheduler,
  appServer: AppServerAdapter,
  store: TranscriptStore,
  meshRunId: string,
  recipient: PublicAgent,
): Promise<void> {
  if (scheduler.stopped) {
    return;
  }
  if (scheduler.delivering.has(recipient.id) || recipient.status === "working") {
    return;
  }
  scheduler.delivering.add(recipient.id);
  try {
    const queue = scheduler.queues.get(recipient.id);
    while (queue && queue.length > 0) {
      const nextMessage = queue[0];
      if (nextMessage && !store.isConversationOpen(nextMessage.conversationId)) {
        queue.shift();
        scheduler.queuedMessageIds.delete(nextMessage.id);
        store.cancelDelivery(
          nextMessage,
          "Delivery cancelled because its Conversation is already terminal.",
        );
        continue;
      }
      if (recipient.status === "unloaded") {
        if (!recipient.threadId) {
          return;
        }
        try {
          await appServer.resumeThread(recipient.threadId);
        } catch (cause) {
          if (scheduler.stopped) {
            return;
          }
          const message = failureMessage(cause);
          for (const failedMessage of queue.splice(0)) {
            scheduler.queuedMessageIds.delete(failedMessage.id);
            store.failDelivery(failedMessage, message);
            if (failedMessage.kind === "question" || failedMessage.kind === "reply") {
              queueSupervisorNotice(scheduler, appServer, store, failedMessage, message);
            }
          }
          return;
        }
        recipient.status = "idle";
        store.updateAgentStatus(meshRunId, recipient);
      }
      if (recipient.status !== "idle") {
        return;
      }
      const message = queue.shift();
      if (message) {
        scheduler.queuedMessageIds.delete(message.id);
        scheduler.handlingConversations.set(recipient.id, message.conversationId);
        let outcome: Awaited<ReturnType<typeof deliverMessage>>;
        try {
          outcome = await deliverMessage(
            scheduler,
            appServer,
            store,
            meshRunId,
            recipient,
            message,
          );
        } finally {
          scheduler.handlingConversations.delete(recipient.id);
        }
        if (scheduler.stopped) {
          return;
        }
        if (!store.isConversationOpen(message.conversationId)) {
          cancelConversationDeadline(scheduler, message.conversationId);
          purgeTerminalConversationFromScheduler(scheduler, store, message.conversationId);
        }
        if (outcome === "ambiguous") {
          return;
        }
      }
    }
    const notices = scheduler.noticeQueues.get(recipient.id);
    if (notices && notices.length > 0 && recipient.status === "unloaded") {
      if (!recipient.threadId) {
        return;
      }
      await appServer.resumeThread(recipient.threadId);
      if (scheduler.stopped) {
        return;
      }
      recipient.status = "idle";
      store.updateAgentStatus(meshRunId, recipient);
    }
    while (notices && notices.length > 0 && recipient.status === "idle") {
      const notice = notices.shift();
      if (!notice || !recipient.threadId) {
        return;
      }
      recipient.status = "working";
      store.updateAgentStatus(meshRunId, recipient);
      try {
        const handling = await appServer.startNotice({
          threadId: recipient.threadId,
          notice,
        });
        await handling.completed;
      } finally {
        if (!scheduler.stopped) {
          recipient.status = "idle";
          store.updateAgentStatus(meshRunId, recipient);
        }
      }
    }
  } finally {
    scheduler.delivering.delete(recipient.id);
  }
}

function queueSupervisorNotice(
  scheduler: DeliveryScheduler,
  appServer: AppServerAdapter,
  store: TranscriptStore,
  message: Message,
  reason: string,
): void {
  const recipientAgentId =
    message.kind === "reply" ? message.recipientAgentId : message.senderAgentId;
  enqueueSupervisorNotice(
    scheduler,
    appServer,
    store,
    store.recordSupervisorNotice(message, reason, recipientAgentId),
  );
}

function enqueueSupervisorNotice(
  scheduler: DeliveryScheduler,
  appServer: AppServerAdapter,
  store: TranscriptStore,
  notice: SupervisorNotice,
): void {
  const recipient = scheduler.agents.find((agent) => agent.id === notice.recipientAgentId);
  if (!recipient) {
    return;
  }
  const queue = scheduler.noticeQueues.get(recipient.id) ?? [];
  scheduler.noticeQueues.set(recipient.id, queue);
  queue.push(notice);
  if (recipient.status === "idle" || recipient.status === "unloaded") {
    scheduleDelivery(scheduler, appServer, store, scheduler.meshRunId, recipient);
  }
}

function peerMessage(
  kind: "notification" | "question",
  id: string,
  conversationId: string,
  senderAgentId: string,
  recipientAgentId: string,
  body: string,
  context: NotificationContext | undefined,
  createdAt: string,
): Message {
  return {
    id,
    kind,
    senderAgentId,
    recipientAgentId,
    conversationId,
    createdAt,
    body,
    ...context,
  };
}

async function deliverMessage(
  scheduler: DeliveryScheduler,
  appServer: AppServerAdapter,
  store: TranscriptStore,
  meshRunId: string,
  recipient: PublicAgent,
  message: Message,
): Promise<"idle" | "ambiguous"> {
  if (!recipient.threadId) {
    return "ambiguous";
  }
  if (!store.markDeliveryInjecting(message)) {
    store.cancelDelivery(
      message,
      "Delivery cancelled because its Conversation is already terminal.",
    );
    return "idle";
  }
  recipient.status = "working";
  store.updateAgentStatus(meshRunId, recipient);
  let handling: Awaited<ReturnType<AppServerAdapter["startHandling"]>>;
  scheduler.startingHandlings.set(recipient.threadId, message);
  try {
    handling = await appServer.startHandling({
      threadId: recipient.threadId,
      message,
    });
  } catch (cause) {
    scheduler.startingHandlings.delete(recipient.threadId);
    if (scheduler.stopped) {
      return "ambiguous";
    }
    const messageText = failureMessage(cause);
    if (cause instanceof HandlingStartError && cause.acceptance === "rejected") {
      store.rejectDelivery(message, messageText);
      if (message.kind === "question" || message.kind === "reply") {
        queueSupervisorNotice(scheduler, appServer, store, message, messageText);
      }
      recipient.status = "idle";
      store.updateAgentStatus(meshRunId, recipient);
      return "idle";
    }
    store.failDelivery(message, messageText);
    if (message.kind === "question" || message.kind === "reply") {
      queueSupervisorNotice(scheduler, appServer, store, message, messageText);
    }
    return "ambiguous";
  }
  scheduler.startingHandlings.delete(recipient.threadId);
  if (scheduler.stopped) {
    void handling.completed.catch(() => {});
    return "ambiguous";
  }
  if (!store.isConversationOpen(message.conversationId)) {
    store.markHandlingActive(message, handling.turnId);
    store.interruptHandling(message, handling.turnId);
    try {
      await appServer.interruptTurn(recipient.threadId, handling.turnId);
    } catch (cause) {
      store.failInterruptedHandling(
        message,
        handling.turnId,
        `Conversation terminated during turn start, but interruption failed: ${failureMessage(cause)}`,
      );
    }
    recipient.status = "idle";
    store.updateAgentStatus(meshRunId, recipient);
    return "idle";
  }
  store.markHandlingActive(message, handling.turnId);
  scheduler.activeHandlings.set(recipient.id, {
    threadId: recipient.threadId,
    turnId: handling.turnId,
    message,
  });
  try {
    const completion = await handling.completed;
    if (scheduler.stopped) {
      return "ambiguous";
    }
    if (
      store.expireConversation(
        message.conversationId,
        effectiveConversationNow(scheduler, message.conversationId),
        scheduler.limits,
      )
    ) {
      queueSupervisorNotice(scheduler, appServer, store, message, "Conversation deadline elapsed.");
    }
    if (!store.isConversationOpen(message.conversationId)) {
      store.completeHandling(message, handling.turnId, completion.finalOutput);
    } else if (message.kind === "question") {
      const finalOutput = completion.finalOutput?.trim();
      if (!finalOutput) {
        enqueueSupervisorNotice(
          scheduler,
          appServer,
          store,
          store.failQuestionWithoutReply(message, handling.turnId),
        );
      } else {
        const reply: Message = {
          id: scheduler.generateOpaqueValue(),
          kind: "reply",
          senderAgentId: message.recipientAgentId,
          recipientAgentId: message.senderAgentId,
          conversationId: message.conversationId,
          createdAt: new Date(scheduler.now()).toISOString(),
          body: finalOutput,
          inReplyTo: message.id,
        };
        const replyRecipient = scheduler.agents.find(
          (agent) => agent.id === reply.recipientAgentId,
        );
        if (!replyRecipient) {
          queueSupervisorNotice(
            scheduler,
            appServer,
            store,
            message,
            "Question asker is unavailable for Reply delivery.",
          );
          store.failHandling(message, handling.turnId, "Question asker is unavailable.");
        } else {
          const acceptance = store.completeQuestionWithReply(
            message,
            handling.turnId,
            finalOutput,
            reply,
            scheduler.limits,
            effectiveConversationNow(scheduler, message.conversationId),
          );
          if (acceptance.accepted) {
            enqueueNotification(scheduler, appServer, store, meshRunId, replyRecipient, reply);
          } else {
            queueSupervisorNotice(scheduler, appServer, store, message, acceptance.reason);
          }
        }
      }
    } else {
      store.completeHandling(message, handling.turnId, completion.finalOutput);
    }
  } catch (cause) {
    if (scheduler.stopped) {
      return "ambiguous";
    }
    store.failHandling(message, handling.turnId, failureMessage(cause));
    if (message.kind === "question" || message.kind === "reply") {
      queueSupervisorNotice(scheduler, appServer, store, message, failureMessage(cause));
    }
  }
  scheduler.activeHandlings.delete(recipient.id);
  recipient.status = "idle";
  store.updateAgentStatus(meshRunId, recipient);
  return "idle";
}

function validateNotificationInput(input: {
  recipientAgentId: string;
  body: string;
  context?: NotificationContext;
}): { recipientAgentId: string; body: string; context?: NotificationContext } {
  if (typeof input.recipientAgentId !== "string" || input.recipientAgentId === "") {
    throw new Error("Notification recipient Agent ID is required.");
  }
  if (
    typeof input.body !== "string" ||
    !isWellFormedUtf8(input.body) ||
    Buffer.byteLength(input.body, "utf8") > 32 * 1024
  ) {
    throw new Error("Notification body must be a UTF-8 string of at most 32 KiB.");
  }
  if (input.context === undefined) {
    return { recipientAgentId: input.recipientAgentId, body: input.body };
  }
  const { subject, fileReferences, gitCommitId, worktreeFingerprint } = input.context;
  if (subject !== undefined && (typeof subject !== "string" || [...subject].length > 200)) {
    throw new Error("Notification subject must contain at most 200 characters.");
  }
  if (
    fileReferences !== undefined &&
    (!Array.isArray(fileReferences) ||
      fileReferences.length > 32 ||
      fileReferences.some((reference) => typeof reference !== "string"))
  ) {
    throw new Error("Notification may contain at most 32 file references.");
  }
  const normalizedReferences = fileReferences?.map(normalizedRepositoryPath);
  if (gitCommitId !== undefined && typeof gitCommitId !== "string") {
    throw new Error("Notification Git commit ID must be a string.");
  }
  if (worktreeFingerprint !== undefined && typeof worktreeFingerprint !== "string") {
    throw new Error("Notification worktree fingerprint must be a string.");
  }
  return {
    recipientAgentId: input.recipientAgentId,
    body: input.body,
    context: {
      ...(subject === undefined ? {} : { subject }),
      ...(normalizedReferences === undefined ? {} : { fileReferences: normalizedReferences }),
      ...(gitCommitId === undefined ? {} : { gitCommitId }),
      ...(worktreeFingerprint === undefined ? {} : { worktreeFingerprint }),
    },
  };
}

function normalizedRepositoryPath(reference: string): string {
  const portableReference = reference.replaceAll("\\", "/");
  const normalizedReference = posix.normalize(portableReference);
  if (
    reference === "" ||
    reference.includes("\0") ||
    posix.isAbsolute(portableReference) ||
    /^[A-Za-z]:\//.test(portableReference) ||
    normalizedReference === ".." ||
    normalizedReference.startsWith("../")
  ) {
    throw new Error("Notification file references must stay within the Repository.");
  }
  return normalizedReference;
}

function isWellFormedUtf8(value: string): boolean {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unknown Notification delivery failure.";
}
