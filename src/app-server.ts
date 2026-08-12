import type { AgentConfiguration, AgentRole, PublicAgent } from "./startup-validation.ts";
import type { Message } from "./transcript-store.ts";

export type AgentSandbox = "workspace-write" | "read-only";

export interface McpServerLaunch {
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface StartThreadRequest extends AgentConfiguration {
  agentId: string;
  agentCredential: string;
  sandbox: AgentSandbox;
  mcpServer: McpServerLaunch;
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

export interface StartHandlingRequest {
  threadId: string;
  message: Message;
}

export interface HandlingCompletion {
  finalOutput?: string;
}

export interface HandlingHandle {
  turnId: string;
  completed: Promise<HandlingCompletion>;
}

export interface AppServerAdapter {
  initialize(): Promise<void>;
  startThread(request: StartThreadRequest): Promise<ThreadHandle>;
  startObjective(request: StartObjectiveRequest): Promise<{ turnId: string }>;
  startHandling(request: StartHandlingRequest): Promise<HandlingHandle>;
  resumeThread(threadId: string): Promise<void>;
  onThreadStatusChanged(listener: ThreadStatusListener): () => void;
  close(): Promise<void>;
}

export type ThreadStatus = "active" | "idle" | "unloaded" | "closed" | "system-error";
export type ThreadStatusListener = (threadId: string, status: ThreadStatus) => void;

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
    async startHandling(): Promise<HandlingHandle> {
      throw new Error("The real Codex app-server Adapter is not available yet.");
    },
    async resumeThread(): Promise<void> {
      throw new Error("The real Codex app-server Adapter is not available yet.");
    },
    onThreadStatusChanged(): () => void {
      return () => {};
    },
    async close(): Promise<void> {},
  };
}

export function sandboxForRole(role: AgentRole): AgentSandbox {
  return role === "writer" ? "workspace-write" : "read-only";
}
