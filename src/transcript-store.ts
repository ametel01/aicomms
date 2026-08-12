import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PublicAgent } from "./startup-validation.ts";

export type MeshRunStatus = "starting" | "running" | "failed" | "stopped";

export interface MeshRun {
  id: string;
  repositoryId: string;
  status: MeshRunStatus;
  agents: PublicAgent[];
  failureMessage?: string;
}

export interface NotificationContext {
  subject?: string;
  fileReferences?: string[];
  gitCommitId?: string;
  worktreeFingerprint?: string;
}

export interface Message extends NotificationContext {
  id: string;
  kind: "notification" | "question" | "reply";
  senderAgentId: string;
  recipientAgentId: string;
  conversationId: string;
  createdAt: string;
  body: string;
  inReplyTo?: string;
}

export interface Delivery {
  messageId: string;
  status:
    | "accepted"
    | "queued"
    | "injecting"
    | "injected"
    | "ambiguous"
    | "rejected"
    | "expired"
    | "cancelled";
  codexTurnId?: string;
  failureMessage?: string;
}

export interface Handling {
  messageId: string;
  status: "starting" | "active" | "completed" | "failed" | "interrupted";
  codexTurnId: string;
  finalOutput?: string;
  failureMessage?: string;
}

export interface TranscriptEvent {
  sequence: number;
  type:
    | "message.accepted"
    | "delivery.queued"
    | "delivery.injecting"
    | "delivery.injected"
    | "handling.active"
    | "handling.completed"
    | "handling.failed"
    | "handling.interrupted"
    | "conversation.completed"
    | "conversation.failed"
    | "conversation.cancelled"
    | "conversation.expired"
    | "conversation.limit_reached"
    | "delivery.rejected"
    | "delivery.cancelled"
    | "delivery.expired"
    | "delivery.ambiguous"
    | "operator_wait.requested"
    | "operator_wait.resolved";
  createdAt: string;
}

export interface ConversationSnapshot {
  id: string;
  status: "open" | "completed" | "failed" | "expired" | "cancelled" | "limit_reached";
  message: Message;
  delivery: Delivery;
  handling?: Handling;
  messages: Message[];
  deliveries: Delivery[];
  handlings: Handling[];
  notices: SupervisorNotice[];
  events: TranscriptEvent[];
}

export interface SupervisorNotice {
  id: number;
  recipientAgentId: string;
  conversationId: string;
  reason: string;
  createdAt: string;
}

export interface OperatorRequest {
  id: string;
  meshRunId: string;
  type: "approval" | "input";
  threadId: string;
  turnId: string;
  prompt: string;
  status: "pending" | "responding" | "resolved" | "delivery_failed" | "cancelled";
  createdAt: string;
  conversationId?: string;
  response?: unknown;
  failureMessage?: string;
  resolvedAt?: string;
}

export interface ConversationLimits {
  agentTriggeredMessages: number;
  totalMessages: number;
  elapsedMilliseconds: number;
}

export type MessageAcceptance =
  | { accepted: true; newConversation: boolean }
  | {
      accepted: false;
      reason: string;
      conversationStatus?: ConversationSnapshot["status"];
    };

interface MeshRunRow {
  id: string;
  repository_id: string;
  status: MeshRunStatus;
  failure_message: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  role: "writer" | "adviser";
  objective: string;
  capabilities: string;
  thread_id: string | null;
  status: "starting" | "working" | "idle" | "unloaded" | "stopped";
}

interface MessageRow {
  id: string;
  kind: Message["kind"];
  sender_agent_id: string;
  recipient_agent_id: string;
  conversation_id: string;
  created_at: string;
  body: string;
  subject: string | null;
  file_references: string | null;
  git_commit_id: string | null;
  worktree_fingerprint: string | null;
  in_reply_to: string | null;
}

interface HandlingRow {
  status: Handling["status"];
  codex_turn_id: string;
  final_output: string | null;
  failure_message: string | null;
}

interface NoticeRow {
  id: number;
  recipient_agent_id: string;
  conversation_id: string;
  reason: string;
  created_at: string;
}

interface OperatorRequestRow {
  id: string;
  mesh_run_id: string;
  type: OperatorRequest["type"];
  thread_id: string;
  turn_id: string;
  conversation_id: string | null;
  prompt: string;
  status: OperatorRequest["status"];
  response: string | null;
  failure_message: string | null;
  created_at: string;
  resolved_at: string | null;
}

export class TranscriptStore {
  private constructor(private readonly database: Database) {}

  static async open(repositoryRoot: string): Promise<TranscriptStore> {
    const stateDirectory = join(repositoryRoot, ".codex-meshd");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    const databasePath = join(stateDirectory, "transcript.sqlite");
    const database = new Database(databasePath, { create: true, strict: true });
    await chmod(databasePath, 0o600);
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS mesh_runs (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        status TEXT NOT NULL,
        failure_message TEXT,
        created_at TEXT NOT NULL,
        stopped_at TEXT
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        mesh_run_id TEXT NOT NULL REFERENCES mesh_runs(id),
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        objective TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        thread_id TEXT,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        mesh_run_id TEXT NOT NULL REFERENCES mesh_runs(id),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        kind TEXT NOT NULL,
        sender_agent_id TEXT NOT NULL REFERENCES agents(id),
        recipient_agent_id TEXT NOT NULL REFERENCES agents(id),
        created_at TEXT NOT NULL,
        body TEXT NOT NULL,
        subject TEXT,
        file_references TEXT,
        git_commit_id TEXT,
        worktree_fingerprint TEXT,
        in_reply_to TEXT
      );
      CREATE TRIGGER IF NOT EXISTS messages_are_immutable
      BEFORE UPDATE ON messages
      BEGIN
        SELECT RAISE(ABORT, 'Messages are immutable');
      END;
      CREATE TABLE IF NOT EXISTS deliveries (
        message_id TEXT PRIMARY KEY REFERENCES messages(id),
        status TEXT NOT NULL,
        codex_turn_id TEXT,
        failure_message TEXT
      );
      CREATE TABLE IF NOT EXISTS handlings (
        message_id TEXT PRIMARY KEY REFERENCES messages(id),
        status TEXT NOT NULL,
        codex_turn_id TEXT NOT NULL,
        final_output TEXT,
        failure_message TEXT
      );
      CREATE TABLE IF NOT EXISTS transcript_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS supervisor_notices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient_agent_id TEXT NOT NULL REFERENCES agents(id),
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operator_requests (
        id TEXT PRIMARY KEY,
        mesh_run_id TEXT NOT NULL REFERENCES mesh_runs(id),
        type TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        conversation_id TEXT REFERENCES conversations(id),
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        response TEXT,
        failure_message TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
    `);
    ensureColumn(database, "deliveries", "failure_message", "TEXT");
    ensureColumn(database, "handlings", "failure_message", "TEXT");
    ensureColumn(database, "operator_requests", "failure_message", "TEXT");
    ensureMessageColumn(database);
    database.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS one_reply_per_question
       ON messages(in_reply_to) WHERE kind = 'reply' AND in_reply_to IS NOT NULL`,
    );
    return new TranscriptStore(database);
  }

  createMeshRun(run: MeshRun): void {
    const insert = this.database.transaction(() => {
      this.database
        .query("INSERT INTO mesh_runs (id, repository_id, status, created_at) VALUES (?, ?, ?, ?)")
        .run(run.id, run.repositoryId, run.status, new Date().toISOString());
      const insertAgent = this.database.query(
        `INSERT INTO agents
          (id, mesh_run_id, name, role, objective, capabilities, thread_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const agent of run.agents) {
        insertAgent.run(
          agent.id,
          run.id,
          agent.name,
          agent.role,
          agent.objective,
          JSON.stringify(agent.capabilities),
          agent.threadId ?? null,
          agent.status,
        );
      }
    });
    insert();
  }

  markRunning(meshRunId: string, agents: PublicAgent[]): void {
    const update = this.database.transaction(() => {
      const updateAgent = this.database.query(
        "UPDATE agents SET thread_id = ?, status = ? WHERE id = ? AND mesh_run_id = ?",
      );
      for (const agent of agents) {
        updateAgent.run(agent.threadId ?? null, agent.status, agent.id, meshRunId);
      }
      this.database.query("UPDATE mesh_runs SET status = 'running' WHERE id = ?").run(meshRunId);
    });
    update();
  }

  markFailed(meshRunId: string, failureMessage: string): void {
    const update = this.database.transaction(() => {
      this.database
        .query("UPDATE mesh_runs SET status = 'failed', failure_message = ? WHERE id = ?")
        .run(failureMessage, meshRunId);
      this.database
        .query("UPDATE agents SET status = 'stopped' WHERE mesh_run_id = ?")
        .run(meshRunId);
    });
    update();
  }

  failStaleMeshRuns(repositoryId: string): string[] {
    const staleRuns = this.database
      .query(
        `SELECT id FROM mesh_runs
         WHERE repository_id = ? AND status IN ('starting', 'running') ORDER BY rowid`,
      )
      .all(repositoryId) as Array<{ id: string }>;
    for (const { id } of staleRuns) {
      this.failMeshRunWithoutReplay(id, "supervisor_lost");
    }
    return staleRuns.map(({ id }) => id);
  }

  failMeshRunWithoutReplay(meshRunId: string, reason: string): boolean {
    let failed = false;
    const fail = this.database.transaction(() => {
      const mesh = this.database
        .query(
          `UPDATE mesh_runs SET status = 'failed', failure_message = ?
           WHERE id = ? AND status IN ('starting', 'running')`,
        )
        .run(reason, meshRunId);
      if (mesh.changes !== 1) {
        return;
      }
      failed = true;
      const conversations = this.database
        .query(
          `SELECT id FROM conversations
           WHERE mesh_run_id = ? AND status = 'open' ORDER BY rowid`,
        )
        .all(meshRunId) as Array<{ id: string }>;
      for (const { id: conversationId } of conversations) {
        const injecting = this.database
          .query(
            `SELECT deliveries.message_id
             FROM deliveries JOIN messages ON messages.id = deliveries.message_id
             WHERE messages.conversation_id = ? AND deliveries.status = 'injecting'`,
          )
          .all(conversationId) as Array<{ message_id: string }>;
        for (const { message_id: messageId } of injecting) {
          this.database
            .query(
              `UPDATE deliveries SET status = 'ambiguous', failure_message = ?
               WHERE message_id = ? AND status = 'injecting'`,
            )
            .run(reason, messageId);
          this.recordEvent(conversationId, "delivery.ambiguous");
        }
        const pending = this.pendingDeliveryIds(conversationId);
        for (const messageId of pending) {
          this.database
            .query(
              `UPDATE deliveries SET status = 'cancelled', failure_message = ?
               WHERE message_id = ?`,
            )
            .run(reason, messageId);
          this.recordEvent(conversationId, "delivery.cancelled");
        }
        const activeHandlings = this.database
          .query(
            `SELECT handlings.message_id
             FROM handlings JOIN messages ON messages.id = handlings.message_id
             WHERE messages.conversation_id = ? AND handlings.status = 'active'`,
          )
          .all(conversationId) as Array<{ message_id: string }>;
        for (const { message_id: messageId } of activeHandlings) {
          this.database
            .query(
              `UPDATE handlings SET status = 'failed', failure_message = ?
               WHERE message_id = ? AND status = 'active'`,
            )
            .run(reason, messageId);
          this.recordEvent(conversationId, "handling.failed");
        }
        const affectedAgents = this.database
          .query(
            `SELECT sender_agent_id AS agent_id FROM messages WHERE conversation_id = ?
             UNION SELECT recipient_agent_id AS agent_id FROM messages WHERE conversation_id = ?`,
          )
          .all(conversationId, conversationId) as Array<{ agent_id: string }>;
        for (const { agent_id: agentId } of affectedAgents) {
          this.database
            .query(
              `INSERT INTO supervisor_notices
                (recipient_agent_id, conversation_id, reason, created_at) VALUES (?, ?, ?, ?)`,
            )
            .run(agentId, conversationId, reason, new Date().toISOString());
        }
        this.database
          .query("UPDATE conversations SET status = 'failed' WHERE id = ? AND status = 'open'")
          .run(conversationId);
        this.recordEvent(conversationId, "conversation.failed");
      }
      this.database
        .query(
          `UPDATE operator_requests SET status = 'cancelled', failure_message = ?, resolved_at = ?
           WHERE mesh_run_id = ? AND status IN ('pending', 'responding', 'delivery_failed')`,
        )
        .run(reason, new Date().toISOString(), meshRunId);
      this.database
        .query("UPDATE agents SET status = 'stopped' WHERE mesh_run_id = ?")
        .run(meshRunId);
    });
    fail();
    return failed;
  }

  markStopped(meshRunId: string): void {
    const update = this.database.transaction(() => {
      this.database
        .query("UPDATE mesh_runs SET status = 'stopped', stopped_at = ? WHERE id = ?")
        .run(new Date().toISOString(), meshRunId);
      this.database
        .query("UPDATE agents SET status = 'stopped' WHERE mesh_run_id = ?")
        .run(meshRunId);
    });
    update();
  }

  updateAgentStatus(meshRunId: string, agent: PublicAgent): void {
    this.database
      .query("UPDATE agents SET status = ? WHERE id = ? AND mesh_run_id = ?")
      .run(agent.status, agent.id, meshRunId);
  }

  recordOperatorRequest(request: OperatorRequest): void {
    const record = this.database.transaction(() => {
      this.database
        .query(
          `INSERT INTO operator_requests
            (id, mesh_run_id, type, thread_id, turn_id, conversation_id, prompt, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          request.id,
          request.meshRunId,
          request.type,
          request.threadId,
          request.turnId,
          request.conversationId ?? null,
          request.prompt,
          request.createdAt,
        );
      if (request.conversationId) {
        this.recordEvent(request.conversationId, "operator_wait.requested");
      }
    });
    record();
  }

  listOperatorRequests(meshRunId?: string): OperatorRequest[] {
    const rows = (
      meshRunId
        ? this.database
            .query("SELECT * FROM operator_requests WHERE mesh_run_id = ? ORDER BY rowid")
            .all(meshRunId)
        : this.database.query("SELECT * FROM operator_requests ORDER BY rowid").all()
    ) as OperatorRequestRow[];
    return rows.map(operatorRequestFromRow);
  }

  beginOperatorRequestResponse(requestId: string, response: unknown): OperatorRequest | undefined {
    const begin = this.database.transaction(() => {
      const current = this.database
        .query("SELECT * FROM operator_requests WHERE id = ?")
        .get(requestId) as OperatorRequestRow | null;
      if (current?.status !== "pending" && current?.status !== "delivery_failed") {
        return undefined;
      }
      this.database
        .query(
          `UPDATE operator_requests
           SET status = 'responding', response = ?, failure_message = NULL, resolved_at = NULL
           WHERE id = ? AND status IN ('pending', 'delivery_failed')`,
        )
        .run(JSON.stringify(response), requestId);
      return operatorRequestFromRow({
        ...current,
        status: "responding",
        response: JSON.stringify(response),
        failure_message: null,
        resolved_at: null,
      });
    });
    return begin();
  }

  completeOperatorRequestResponse(requestId: string): OperatorRequest | undefined {
    const resolvedAt = new Date().toISOString();
    const complete = this.database.transaction(() => {
      const current = this.database
        .query("SELECT * FROM operator_requests WHERE id = ?")
        .get(requestId) as OperatorRequestRow | null;
      if (current?.status !== "responding") {
        return undefined;
      }
      this.database
        .query(
          `UPDATE operator_requests
           SET status = 'resolved', failure_message = NULL, resolved_at = ?
           WHERE id = ? AND status = 'responding'`,
        )
        .run(resolvedAt, requestId);
      if (current.conversation_id) {
        this.recordEvent(current.conversation_id, "operator_wait.resolved");
      }
      return operatorRequestFromRow({
        ...current,
        status: "resolved",
        failure_message: null,
        resolved_at: resolvedAt,
      });
    });
    return complete();
  }

  failOperatorRequestResponse(
    requestId: string,
    failureMessage: string,
  ): OperatorRequest | undefined {
    const current = this.database
      .query("SELECT * FROM operator_requests WHERE id = ?")
      .get(requestId) as OperatorRequestRow | null;
    if (current?.status !== "responding") {
      return undefined;
    }
    this.database
      .query(
        `UPDATE operator_requests
         SET status = 'delivery_failed', failure_message = ?, resolved_at = NULL
         WHERE id = ? AND status = 'responding'`,
      )
      .run(failureMessage, requestId);
    return operatorRequestFromRow({
      ...current,
      status: "delivery_failed",
      failure_message: failureMessage,
      resolved_at: null,
    });
  }

  recordAgentMessage(
    meshRunId: string,
    message: Message,
    startsConversation: boolean,
    limits: ConversationLimits,
    now: number,
  ): MessageAcceptance {
    let result: MessageAcceptance = { accepted: false, reason: "Message acceptance failed." };
    const record = this.database.transaction(() => {
      if (this.messageExists(message.id)) {
        result = { accepted: false, reason: "Duplicate Message ID was rejected." };
        return;
      }
      const conversation = this.conversationRow(message.conversationId);
      if (startsConversation) {
        if (conversation) {
          result = { accepted: false, reason: "Duplicate Conversation ID was rejected." };
          return;
        }
        this.database
          .query(
            `INSERT INTO conversations (id, mesh_run_id, status, created_at)
             VALUES (?, ?, 'open', ?)`,
          )
          .run(message.conversationId, meshRunId, message.createdAt);
      } else if (!conversation) {
        result = { accepted: false, reason: "Causal Conversation was not found." };
        return;
      } else if (conversation.status !== "open") {
        result = {
          accepted: false,
          reason: `Conversation is already ${conversation.status}.`,
          conversationStatus: conversation.status,
        };
        return;
      } else if (now - Date.parse(conversation.created_at) >= limits.elapsedMilliseconds) {
        this.terminateConversation(message.conversationId, "expired");
        result = {
          accepted: false,
          reason: "Conversation deadline has elapsed.",
          conversationStatus: "expired",
        };
        return;
      }
      if (this.hasRepeatedMessage(message)) {
        result = {
          accepted: false,
          reason: "Repeated sender-recipient-body Message was rejected.",
        };
        return;
      }
      const counts = this.messageCounts(message.conversationId);
      if (counts.agentTriggered >= limits.agentTriggeredMessages) {
        this.terminateConversation(message.conversationId, "limit_reached");
        result = {
          accepted: false,
          reason: `Conversation Agent-triggering Message limit of ${limits.agentTriggeredMessages} has been reached.`,
          conversationStatus: "limit_reached",
        };
        return;
      }
      if (counts.total >= limits.totalMessages) {
        this.terminateConversation(message.conversationId, "limit_reached");
        result = {
          accepted: false,
          reason: `Conversation total Message limit of ${limits.totalMessages} has been reached.`,
          conversationStatus: "limit_reached",
        };
        return;
      }
      this.insertMessage(message);
      this.recordEvent(message.conversationId, "message.accepted");
      result = { accepted: true, newConversation: startsConversation };
    });
    record();
    return result;
  }

  completeQuestionWithReply(
    message: Message,
    turnId: string,
    finalOutput: string,
    reply: Message,
    limits: ConversationLimits,
    now: number,
  ): MessageAcceptance {
    let result: MessageAcceptance = { accepted: false, reason: "Reply acceptance failed." };
    const complete = this.database.transaction(() => {
      const handlingResult = this.database
        .query(
          `UPDATE handlings SET status = 'completed', final_output = ?
           WHERE message_id = ? AND codex_turn_id = ? AND status = 'active'`,
        )
        .run(finalOutput, message.id, turnId);
      if (handlingResult.changes !== 1) {
        result = { accepted: false, reason: "Question Handling is no longer active." };
        return;
      }
      this.recordEvent(message.conversationId, "handling.completed");
      const conversation = this.conversationRow(message.conversationId);
      if (conversation?.status !== "open") {
        result = {
          accepted: false,
          reason: `Conversation is already ${conversation?.status ?? "unavailable"}.`,
          ...(conversation ? { conversationStatus: conversation.status } : {}),
        };
        return;
      }
      if (now - Date.parse(conversation.created_at) >= limits.elapsedMilliseconds) {
        this.terminateConversation(message.conversationId, "expired");
        result = {
          accepted: false,
          reason: "Conversation deadline elapsed before Reply acceptance.",
          conversationStatus: "expired",
        };
        return;
      }
      if (
        this.messageExists(reply.id) ||
        this.hasRepeatedMessage(reply) ||
        this.hasReplyForQuestion(message.id)
      ) {
        this.failConversationIfOpen(message.conversationId);
        result = {
          accepted: false,
          reason: "Correlated Reply was rejected as a duplicate.",
          conversationStatus: "failed",
        };
        return;
      }
      if (this.messageCounts(message.conversationId).total >= limits.totalMessages) {
        this.terminateConversation(message.conversationId, "limit_reached");
        result = {
          accepted: false,
          reason: `Conversation total Message limit of ${limits.totalMessages} has been reached.`,
          conversationStatus: "limit_reached",
        };
        return;
      }
      this.insertMessage(reply);
      this.recordEvent(reply.conversationId, "message.accepted");
      result = { accepted: true, newConversation: false };
    });
    complete();
    return result;
  }

  failQuestionWithoutReply(message: Message, turnId: string): SupervisorNotice {
    this.failHandling(message, turnId, "Question Handling produced no final assistant output.");
    return this.recordSupervisorNotice(message, "Question Handling produced no Reply.");
  }

  recordSupervisorNotice(
    message: Message,
    reason: string,
    recipientAgentId = message.senderAgentId,
  ): SupervisorNotice {
    const createdAt = new Date().toISOString();
    const result = this.database
      .query(
        `INSERT INTO supervisor_notices
          (recipient_agent_id, conversation_id, reason, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(recipientAgentId, message.conversationId, reason, createdAt);
    return {
      id: Number(result.lastInsertRowid),
      recipientAgentId,
      conversationId: message.conversationId,
      reason,
      createdAt,
    };
  }

  markDeliveryInjecting(message: Message): boolean {
    let claimed = false;
    const update = this.database.transaction(() => {
      const result = this.database
        .query(
          `UPDATE deliveries SET status = 'injecting'
           WHERE message_id = ? AND status IN ('accepted', 'queued')
             AND EXISTS (
               SELECT 1
               FROM messages
               JOIN conversations ON conversations.id = messages.conversation_id
               WHERE messages.id = deliveries.message_id AND conversations.status = 'open'
             )`,
        )
        .run(message.id);
      if (result.changes !== 1) {
        return;
      }
      claimed = true;
      this.recordEvent(message.conversationId, "delivery.injecting");
    });
    update();
    return claimed;
  }

  markDeliveryQueued(message: Message): void {
    const update = this.database.transaction(() => {
      this.database
        .query("UPDATE deliveries SET status = 'queued' WHERE message_id = ?")
        .run(message.id);
      this.recordEvent(message.conversationId, "delivery.queued");
    });
    update();
  }

  isConversationOpen(conversationId: string): boolean {
    const row = this.database
      .query("SELECT status FROM conversations WHERE id = ?")
      .get(conversationId) as { status: ConversationSnapshot["status"] } | null;
    return row?.status === "open";
  }

  cancelConversation(meshRunId: string, conversationId: string): boolean {
    let cancelled = false;
    const cancel = this.database.transaction(() => {
      const result = this.database
        .query(
          `UPDATE conversations SET status = 'cancelled'
           WHERE id = ? AND mesh_run_id = ? AND status = 'open'`,
        )
        .run(conversationId, meshRunId);
      if (result.changes !== 1) {
        return;
      }
      cancelled = true;
      const pending = this.pendingDeliveryIds(conversationId);
      for (const messageId of pending) {
        this.database
          .query(
            `UPDATE deliveries SET status = 'cancelled', failure_message = ? WHERE message_id = ?`,
          )
          .run("Conversation was cancelled by the Operator.", messageId);
        this.recordEvent(conversationId, "delivery.cancelled");
      }
      this.database
        .query(
          `UPDATE operator_requests SET status = 'cancelled', resolved_at = ?
           WHERE conversation_id = ?
             AND status IN ('pending', 'responding', 'delivery_failed')`,
        )
        .run(new Date().toISOString(), conversationId);
      this.recordEvent(conversationId, "conversation.cancelled");
    });
    cancel();
    return cancelled;
  }

  expireConversation(conversationId: string, now: number, limits: ConversationLimits): boolean {
    const conversation = this.conversationRow(conversationId);
    if (
      conversation?.status !== "open" ||
      now - Date.parse(conversation.created_at) < limits.elapsedMilliseconds
    ) {
      return false;
    }
    this.database.transaction(() => this.terminateConversation(conversationId, "expired"))();
    return true;
  }

  cancelDelivery(message: Message, failureMessage: string): void {
    const cancel = this.database.transaction(() => {
      const result = this.database
        .query(
          `UPDATE deliveries SET status = 'cancelled', failure_message = ?
           WHERE message_id = ? AND status IN ('accepted', 'queued')`,
        )
        .run(failureMessage, message.id);
      if (result.changes === 1) {
        this.recordEvent(message.conversationId, "delivery.cancelled");
      }
    });
    cancel();
  }

  completeHandling(message: Message, turnId: string, finalOutput?: string): void {
    const complete = this.database.transaction(() => {
      const result = this.database
        .query(
          `UPDATE handlings SET status = 'completed', final_output = ?
           WHERE message_id = ? AND codex_turn_id = ? AND status = 'active'`,
        )
        .run(finalOutput ?? null, message.id, turnId);
      if (result.changes !== 1) {
        return;
      }
      this.recordEvent(message.conversationId, "handling.completed");
      this.completeConversationIfReady(message.conversationId);
    });
    complete();
  }

  markHandlingActive(message: Message, turnId: string): void {
    const activate = this.database.transaction(() => {
      this.database
        .query("UPDATE deliveries SET status = 'injected', codex_turn_id = ? WHERE message_id = ?")
        .run(turnId, message.id);
      this.recordEvent(message.conversationId, "delivery.injected");
      this.database
        .query("INSERT INTO handlings (message_id, status, codex_turn_id) VALUES (?, 'active', ?)")
        .run(message.id, turnId);
      this.recordEvent(message.conversationId, "handling.active");
    });
    activate();
  }

  failDelivery(message: Message, failureMessage: string): void {
    const fail = this.database.transaction(() => {
      this.database
        .query(
          "UPDATE deliveries SET status = 'ambiguous', failure_message = ? WHERE message_id = ?",
        )
        .run(failureMessage, message.id);
      this.recordEvent(message.conversationId, "delivery.ambiguous");
      this.failConversationIfOpen(message.conversationId);
    });
    fail();
  }

  rejectDelivery(message: Message, failureMessage: string): void {
    const reject = this.database.transaction(() => {
      this.database
        .query(
          "UPDATE deliveries SET status = 'rejected', failure_message = ? WHERE message_id = ?",
        )
        .run(failureMessage, message.id);
      this.recordEvent(message.conversationId, "delivery.rejected");
      this.failConversationIfOpen(message.conversationId);
    });
    reject();
  }

  failHandling(message: Message, turnId: string, failureMessage: string): void {
    const fail = this.database.transaction(() => {
      const result = this.database
        .query(
          `UPDATE handlings SET status = 'failed', failure_message = ?
           WHERE message_id = ? AND codex_turn_id = ? AND status = 'active'`,
        )
        .run(failureMessage, message.id, turnId);
      if (result.changes !== 1) {
        return;
      }
      this.recordEvent(message.conversationId, "handling.failed");
      this.failConversationIfOpen(message.conversationId);
    });
    fail();
  }

  interruptHandling(message: Message, turnId: string): void {
    const interrupt = this.database.transaction(() => {
      const result = this.database
        .query(
          `UPDATE handlings SET status = 'interrupted', failure_message = ?
           WHERE message_id = ? AND codex_turn_id = ? AND status = 'active'`,
        )
        .run("Conversation was cancelled by the Operator.", message.id, turnId);
      if (result.changes === 1) {
        this.recordEvent(message.conversationId, "handling.interrupted");
      }
    });
    interrupt();
  }

  failInterruptedHandling(message: Message, turnId: string, failureMessage: string): void {
    this.database
      .query(
        `UPDATE handlings SET failure_message = ?
         WHERE message_id = ? AND codex_turn_id = ? AND status = 'interrupted'`,
      )
      .run(failureMessage, message.id, turnId);
  }

  inspectConversation(conversationId: string): ConversationSnapshot | undefined {
    const conversation = this.database
      .query("SELECT id, status FROM conversations WHERE id = ?")
      .get(conversationId) as { id: string; status: ConversationSnapshot["status"] } | null;
    if (!conversation) {
      return undefined;
    }
    const messages = (
      this.database
        .query("SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid")
        .all(conversationId) as MessageRow[]
    ).map(messageFromRow);
    const message = messages[0];
    if (!message) {
      return undefined;
    }
    const deliveries = messages.map((candidate) => {
      const row = this.database
        .query("SELECT status, codex_turn_id, failure_message FROM deliveries WHERE message_id = ?")
        .get(candidate.id) as {
        status: Delivery["status"];
        codex_turn_id: string | null;
        failure_message: string | null;
      };
      return deliveryFromRow(candidate.id, row);
    });
    const handlings = messages.flatMap((candidate) => {
      const row = this.database
        .query(
          "SELECT status, codex_turn_id, final_output, failure_message FROM handlings WHERE message_id = ?",
        )
        .get(candidate.id) as HandlingRow | null;
      return row ? [handlingFromRow(candidate.id, row)] : [];
    });
    const eventRows = this.database
      .query(
        "SELECT sequence, type, created_at FROM transcript_events WHERE conversation_id = ? ORDER BY sequence",
      )
      .all(conversationId) as Array<{
      sequence: number;
      type: TranscriptEvent["type"];
      created_at: string;
    }>;
    return {
      id: conversation.id,
      status: conversation.status,
      message,
      delivery: deliveries[0] as Delivery,
      ...(handlings[0] ? { handling: handlings[0] } : {}),
      messages,
      deliveries,
      handlings,
      notices: this.database
        .query(
          "SELECT id, recipient_agent_id, conversation_id, reason, created_at FROM supervisor_notices WHERE conversation_id = ? ORDER BY id",
        )
        .all(conversationId)
        .map((row) => noticeFromRow(row as NoticeRow)),
      events: eventRows.map((event) => ({
        sequence: event.sequence,
        type: event.type,
        createdAt: event.created_at,
      })),
    };
  }

  inspectMeshRun(meshRunId: string): MeshRun | undefined {
    const run = this.database
      .query("SELECT id, repository_id, status, failure_message FROM mesh_runs WHERE id = ?")
      .get(meshRunId) as MeshRunRow | null;
    if (!run) {
      return undefined;
    }
    const agentRows = this.database
      .query(
        `SELECT id, name, role, objective, capabilities, thread_id, status
         FROM agents WHERE mesh_run_id = ? ORDER BY rowid`,
      )
      .all(meshRunId) as AgentRow[];
    return {
      id: run.id,
      repositoryId: run.repository_id,
      status: run.status,
      agents: agentRows.map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        objective: agent.objective,
        capabilities: JSON.parse(agent.capabilities) as string[],
        ...(agent.thread_id === null ? {} : { threadId: agent.thread_id }),
        status: agent.status,
      })),
      ...(run.failure_message === null ? {} : { failureMessage: run.failure_message }),
    };
  }

  close(): void {
    this.database.close();
  }

  private recordEvent(conversationId: string, type: TranscriptEvent["type"]): void {
    this.database
      .query("INSERT INTO transcript_events (conversation_id, type, created_at) VALUES (?, ?, ?)")
      .run(conversationId, type, new Date().toISOString());
  }

  private conversationRow(conversationId: string): {
    status: ConversationSnapshot["status"];
    created_at: string;
  } | null {
    return this.database
      .query("SELECT status, created_at FROM conversations WHERE id = ?")
      .get(conversationId) as {
      status: ConversationSnapshot["status"];
      created_at: string;
    } | null;
  }

  private messageExists(messageId: string): boolean {
    return Boolean(this.database.query("SELECT 1 FROM messages WHERE id = ?").get(messageId));
  }

  private hasRepeatedMessage(message: Message): boolean {
    return Boolean(
      this.database
        .query(
          `SELECT 1 FROM messages
           WHERE conversation_id = ? AND sender_agent_id = ? AND recipient_agent_id = ? AND body = ?
           LIMIT 1`,
        )
        .get(message.conversationId, message.senderAgentId, message.recipientAgentId, message.body),
    );
  }

  private hasReplyForQuestion(questionId: string): boolean {
    return Boolean(
      this.database
        .query("SELECT 1 FROM messages WHERE kind = 'reply' AND in_reply_to = ? LIMIT 1")
        .get(questionId),
    );
  }

  private messageCounts(conversationId: string): { agentTriggered: number; total: number } {
    const row = this.database
      .query(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN kind != 'reply' THEN 1 ELSE 0 END) AS agent_triggered
         FROM messages WHERE conversation_id = ?`,
      )
      .get(conversationId) as { total: number; agent_triggered: number | null };
    return { total: row.total, agentTriggered: row.agent_triggered ?? 0 };
  }

  private failConversationIfOpen(conversationId: string): void {
    const result = this.database
      .query("UPDATE conversations SET status = 'failed' WHERE id = ? AND status = 'open'")
      .run(conversationId);
    if (result.changes === 1) {
      this.recordEvent(conversationId, "conversation.failed");
    }
  }

  private pendingDeliveryIds(conversationId: string): string[] {
    return (
      this.database
        .query(
          `SELECT deliveries.message_id
           FROM deliveries
           JOIN messages ON messages.id = deliveries.message_id
           WHERE messages.conversation_id = ? AND deliveries.status IN ('accepted', 'queued')`,
        )
        .all(conversationId) as Array<{ message_id: string }>
    ).map(({ message_id: messageId }) => messageId);
  }

  private terminateConversation(conversationId: string, status: "expired" | "limit_reached"): void {
    const result = this.database
      .query("UPDATE conversations SET status = ? WHERE id = ? AND status = 'open'")
      .run(status, conversationId);
    if (result.changes !== 1) {
      return;
    }
    const pending = this.pendingDeliveryIds(conversationId);
    const deliveryStatus = status === "expired" ? "expired" : "cancelled";
    const deliveryEvent = status === "expired" ? "delivery.expired" : "delivery.cancelled";
    for (const messageId of pending) {
      this.database
        .query("UPDATE deliveries SET status = ?, failure_message = ? WHERE message_id = ?")
        .run(
          deliveryStatus,
          status === "expired"
            ? "Conversation deadline elapsed before Delivery."
            : "Conversation Message limit was reached before Delivery.",
          messageId,
        );
      this.recordEvent(conversationId, deliveryEvent);
    }
    this.recordEvent(
      conversationId,
      status === "expired" ? "conversation.expired" : "conversation.limit_reached",
    );
  }

  private completeConversationIfReady(conversationId: string): void {
    const incomplete = this.database
      .query(
        `SELECT 1
         FROM messages AS message
         LEFT JOIN deliveries AS delivery ON delivery.message_id = message.id
         LEFT JOIN handlings AS handling ON handling.message_id = message.id
         WHERE message.conversation_id = ?
           AND (
             delivery.status != 'injected'
             OR handling.status != 'completed'
             OR (
               message.kind = 'question'
               AND NOT EXISTS (
                 SELECT 1 FROM messages AS reply
                 WHERE reply.kind = 'reply' AND reply.in_reply_to = message.id
               )
             )
           )
         LIMIT 1`,
      )
      .get(conversationId);
    if (incomplete) {
      return;
    }
    const result = this.database
      .query("UPDATE conversations SET status = 'completed' WHERE id = ? AND status = 'open'")
      .run(conversationId);
    if (result.changes === 1) {
      this.recordEvent(conversationId, "conversation.completed");
    }
  }

  private insertMessage(message: Message): void {
    this.database
      .query(
        `INSERT INTO messages
          (id, conversation_id, kind, sender_agent_id, recipient_agent_id, created_at, body,
           subject, file_references, git_commit_id, worktree_fingerprint, in_reply_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.conversationId,
        message.kind,
        message.senderAgentId,
        message.recipientAgentId,
        message.createdAt,
        message.body,
        message.subject ?? null,
        message.fileReferences ? JSON.stringify(message.fileReferences) : null,
        message.gitCommitId ?? null,
        message.worktreeFingerprint ?? null,
        message.inReplyTo ?? null,
      );
    this.database
      .query("INSERT INTO deliveries (message_id, status) VALUES (?, 'accepted')")
      .run(message.id);
  }
}

function messageFromRow(row: MessageRow): Message {
  return {
    id: row.id,
    kind: row.kind,
    senderAgentId: row.sender_agent_id,
    recipientAgentId: row.recipient_agent_id,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    body: row.body,
    ...(row.subject ? { subject: row.subject } : {}),
    ...(row.file_references ? { fileReferences: JSON.parse(row.file_references) as string[] } : {}),
    ...(row.git_commit_id ? { gitCommitId: row.git_commit_id } : {}),
    ...(row.worktree_fingerprint ? { worktreeFingerprint: row.worktree_fingerprint } : {}),
    ...(row.in_reply_to ? { inReplyTo: row.in_reply_to } : {}),
  };
}

function deliveryFromRow(
  messageId: string,
  row: { status: Delivery["status"]; codex_turn_id: string | null; failure_message: string | null },
): Delivery {
  return {
    messageId,
    status: row.status,
    ...(row.codex_turn_id ? { codexTurnId: row.codex_turn_id } : {}),
    ...(row.failure_message ? { failureMessage: row.failure_message } : {}),
  };
}

function handlingFromRow(messageId: string, row: HandlingRow): Handling {
  return {
    messageId,
    status: row.status,
    codexTurnId: row.codex_turn_id,
    ...(row.final_output ? { finalOutput: row.final_output } : {}),
    ...(row.failure_message ? { failureMessage: row.failure_message } : {}),
  };
}

function noticeFromRow(row: NoticeRow): SupervisorNotice {
  return {
    id: row.id,
    recipientAgentId: row.recipient_agent_id,
    conversationId: row.conversation_id,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function operatorRequestFromRow(row: OperatorRequestRow): OperatorRequest {
  return {
    id: row.id,
    meshRunId: row.mesh_run_id,
    type: row.type,
    threadId: row.thread_id,
    turnId: row.turn_id,
    prompt: row.prompt,
    status: row.status,
    createdAt: row.created_at,
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    ...(row.response ? { response: JSON.parse(row.response) as unknown } : {}),
    ...(row.failure_message ? { failureMessage: row.failure_message } : {}),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  };
}

function ensureColumn(
  database: Database,
  table: "deliveries" | "handlings" | "operator_requests",
  column: "failure_message",
  definition: "TEXT",
): void {
  const columns = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureMessageColumn(database: Database): void {
  const columns = database.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === "in_reply_to")) {
    database.exec("ALTER TABLE messages ADD COLUMN in_reply_to TEXT");
  }
}
