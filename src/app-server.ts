import type { AgentConfiguration, AgentRole, PublicAgent } from "./startup-validation.ts";

export type AgentSandbox = "workspace-write" | "read-only";

export interface StartThreadRequest extends AgentConfiguration {
  agentId: string;
  agentCredential: string;
  sandbox: AgentSandbox;
}

export interface ThreadHandle {
  threadId: string;
  mcpReady: boolean;
}

export interface StartObjectiveRequest {
  threadId: string;
  objective: string;
  roster: PublicAgent[];
}

export interface AppServerAdapter {
  initialize(): Promise<void>;
  startThread(request: StartThreadRequest): Promise<ThreadHandle>;
  startObjective(request: StartObjectiveRequest): Promise<{ turnId: string }>;
  close(): Promise<void>;
}

export function unavailableAppServerAdapter(): AppServerAdapter {
  return {
    async initialize(): Promise<void> {
      throw new Error("The real Codex app-server Adapter is not available yet.");
    },
    async startThread(): Promise<ThreadHandle> {
      throw new Error("The real Codex app-server Adapter is not available yet.");
    },
    async startObjective(): Promise<{ turnId: string }> {
      throw new Error("The real Codex app-server Adapter is not available yet.");
    },
    async close(): Promise<void> {},
  };
}

export function sandboxForRole(role: AgentRole): AgentSandbox {
  return role === "writer" ? "workspace-write" : "read-only";
}
