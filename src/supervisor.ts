import { randomBytes, randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
  type AppServerAdapter,
  HandlingStartError,
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
  type ConversationSnapshot,
  type MeshRun,
  type Message,
  type NotificationContext,
  type SupervisorNotice,
  TranscriptStore,
} from "./transcript-store.ts";

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
  inspectConversation(request: {
    cwd: string;
    conversationId: string;
  }): Promise<ConversationSnapshot | undefined>;
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
      const scheduler: DeliveryScheduler = {
        queues: new Map(),
        delivering: new Set(),
        queuedMessageIds: new Set(),
        generateOpaqueValue,
        agents: [],
        noticeQueues: new Map(),
        meshRunId,
        handlingConversations: new Map(),
      };

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
        scheduler.agents = agents;
        const acceptPeerMessage = async (
          kind: "notification" | "question",
          callerAgentId: string,
          input: SendNotificationInput,
        ): Promise<string> => {
          if (!store) {
            throw new Error("Transcript is unavailable.");
          }
          const transcript = store;
          const validatedInput = validateNotificationInput(input);
          const recipient = agents.find((agent) => agent.id === input.recipientAgentId);
          if (!recipient?.threadId) {
            throw new Error("Recipient Agent is unavailable.");
          }
          enforceQueueCapacity(scheduler, recipient);
          const message = peerMessage(
            kind,
            generateOpaqueValue(),
            scheduler.handlingConversations.get(callerAgentId) ?? generateOpaqueValue(),
            callerAgentId,
            validatedInput.recipientAgentId,
            validatedInput.body,
            validatedInput.context,
          );
          transcript.recordNotification(meshRunId, message);
          enqueueNotification(scheduler, appServer, transcript, meshRunId, recipient, message);
          return message.id;
        };
        discoveryServer = await DiscoveryServer.start(
          validation.repository.rootDirectory,
          agentRuntime.map(({ agent, credential }) => ({ agentId: agent.id, credential })),
          agents,
          {
            sendNotification: (callerAgentId, input) =>
              acceptPeerMessage("notification", callerAgentId, input),
            askQuestion: (callerAgentId, input) =>
              acceptPeerMessage("question", callerAgentId, input),
          },
        );
        await appServer.initialize();
        unsubscribeFromThreadStatus = appServer.onThreadStatusChanged((threadId, status) => {
          const agent = agents.find((candidate) => candidate.threadId === threadId);
          if (!agent) {
            return;
          }
          agent.status = lifecycleStatus(status);
          store?.updateAgentStatus(meshRunId, agent);
          if ((agent.status === "idle" || agent.status === "unloaded") && store) {
            scheduleDelivery(scheduler, appServer, store, meshRunId, agent);
          }
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
}

const MAX_QUEUED_MESSAGES_PER_AGENT = 32;
const MAX_QUEUED_MESSAGES_PER_MESH = 128;

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
        recipient.status = "idle";
        store.updateAgentStatus(meshRunId, recipient);
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
): Message {
  return {
    id,
    kind,
    senderAgentId,
    recipientAgentId,
    conversationId,
    createdAt: new Date().toISOString(),
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
  try {
    handling = await appServer.startHandling({
      threadId: recipient.threadId,
      message,
    });
  } catch (cause) {
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
  store.markHandlingActive(message, handling.turnId);
  try {
    const completion = await handling.completed;
    if (message.kind === "question") {
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
          createdAt: new Date().toISOString(),
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
          store.completeQuestionWithReply(message, handling.turnId, finalOutput, reply);
          enqueueNotification(scheduler, appServer, store, meshRunId, replyRecipient, reply);
        }
      }
    } else {
      store.completeNotificationHandling(message, handling.turnId, completion.finalOutput);
    }
  } catch (cause) {
    store.failHandling(message, handling.turnId, failureMessage(cause));
    if (message.kind === "question" || message.kind === "reply") {
      queueSupervisorNotice(scheduler, appServer, store, message, failureMessage(cause));
    }
  }
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
