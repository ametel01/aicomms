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
  kind: "notification";
  senderAgentId: string;
  recipientAgentId: string;
  conversationId: string;
  createdAt: string;
  body: string;
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
    | "conversation.completed"
    | "conversation.failed"
    | "delivery.ambiguous";
  createdAt: string;
}

export interface ConversationSnapshot {
  id: string;
  status: "open" | "completed" | "failed" | "expired" | "cancelled" | "limit_reached";
  message: Message;
  delivery: Delivery;
  handling?: Handling;
  events: TranscriptEvent[];
}

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
  kind: "notification";
  sender_agent_id: string;
  recipient_agent_id: string;
  conversation_id: string;
  created_at: string;
  body: string;
  subject: string | null;
  file_references: string | null;
  git_commit_id: string | null;
  worktree_fingerprint: string | null;
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
        worktree_fingerprint TEXT
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
    `);
    ensureColumn(database, "deliveries", "failure_message", "TEXT");
    ensureColumn(database, "handlings", "failure_message", "TEXT");
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

  recordNotification(meshRunId: string, message: Message): void {
    const record = this.database.transaction(() => {
      this.database
        .query(
          "INSERT INTO conversations (id, mesh_run_id, status, created_at) VALUES (?, ?, 'open', ?)",
        )
        .run(message.conversationId, meshRunId, message.createdAt);
      this.database
        .query(
          `INSERT INTO messages
            (id, conversation_id, kind, sender_agent_id, recipient_agent_id, created_at, body,
             subject, file_references, git_commit_id, worktree_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        );
      this.database
        .query("INSERT INTO deliveries (message_id, status) VALUES (?, 'accepted')")
        .run(message.id);
      this.recordEvent(message.conversationId, "message.accepted");
    });
    record();
  }

  markDeliveryInjecting(message: Message): void {
    const update = this.database.transaction(() => {
      this.database
        .query("UPDATE deliveries SET status = 'injecting' WHERE message_id = ?")
        .run(message.id);
      this.recordEvent(message.conversationId, "delivery.injecting");
    });
    update();
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

  completeNotificationHandling(message: Message, turnId: string, finalOutput?: string): void {
    const complete = this.database.transaction(() => {
      this.database
        .query(
          "UPDATE handlings SET status = 'completed', final_output = ? WHERE message_id = ? AND codex_turn_id = ?",
        )
        .run(finalOutput ?? null, message.id, turnId);
      this.recordEvent(message.conversationId, "handling.completed");
      this.database
        .query("UPDATE conversations SET status = 'completed' WHERE id = ?")
        .run(message.conversationId);
      this.recordEvent(message.conversationId, "conversation.completed");
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
      this.database
        .query("UPDATE conversations SET status = 'failed' WHERE id = ?")
        .run(message.conversationId);
      this.recordEvent(message.conversationId, "conversation.failed");
    });
    fail();
  }

  failHandling(message: Message, turnId: string, failureMessage: string): void {
    const fail = this.database.transaction(() => {
      this.database
        .query(
          "UPDATE handlings SET status = 'failed', failure_message = ? WHERE message_id = ? AND codex_turn_id = ?",
        )
        .run(failureMessage, message.id, turnId);
      this.recordEvent(message.conversationId, "handling.failed");
      this.database
        .query("UPDATE conversations SET status = 'failed' WHERE id = ?")
        .run(message.conversationId);
      this.recordEvent(message.conversationId, "conversation.failed");
    });
    fail();
  }

  inspectConversation(conversationId: string): ConversationSnapshot | undefined {
    const conversation = this.database
      .query("SELECT id, status FROM conversations WHERE id = ?")
      .get(conversationId) as { id: string; status: ConversationSnapshot["status"] } | null;
    if (!conversation) {
      return undefined;
    }
    const row = this.database
      .query("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at LIMIT 1")
      .get(conversationId) as MessageRow;
    const message = messageFromRow(row);
    const deliveryRow = this.database
      .query("SELECT status, codex_turn_id, failure_message FROM deliveries WHERE message_id = ?")
      .get(message.id) as {
      status: Delivery["status"];
      codex_turn_id: string | null;
      failure_message: string | null;
    };
    const handlingRow = this.database
      .query(
        "SELECT status, codex_turn_id, final_output, failure_message FROM handlings WHERE message_id = ?",
      )
      .get(message.id) as {
      status: Handling["status"];
      codex_turn_id: string;
      final_output: string | null;
      failure_message: string | null;
    } | null;
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
      delivery: {
        messageId: message.id,
        status: deliveryRow.status,
        ...(deliveryRow.codex_turn_id ? { codexTurnId: deliveryRow.codex_turn_id } : {}),
        ...(deliveryRow.failure_message ? { failureMessage: deliveryRow.failure_message } : {}),
      },
      ...(handlingRow
        ? {
            handling: {
              messageId: message.id,
              status: handlingRow.status,
              codexTurnId: handlingRow.codex_turn_id,
              ...(handlingRow.final_output ? { finalOutput: handlingRow.final_output } : {}),
              ...(handlingRow.failure_message
                ? { failureMessage: handlingRow.failure_message }
                : {}),
            },
          }
        : {}),
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
  };
}

function ensureColumn(
  database: Database,
  table: "deliveries" | "handlings",
  column: "failure_message",
  definition: "TEXT",
): void {
  const columns = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
