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
  status: "starting" | "working" | "idle" | "stopped";
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
    `);
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
}
