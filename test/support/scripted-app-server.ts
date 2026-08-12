import type {
  AppServerAdapter,
  StartObjectiveRequest,
  StartThreadRequest,
  ThreadHandle,
} from "../../src/app-server.ts";

export type ScriptedFailure =
  | "initialize"
  | "writer-thread"
  | "adviser-thread"
  | "mcp"
  | "writer-objective"
  | "close";

export class ScriptedAppServer implements AppServerAdapter {
  readonly calls: Array<
    | { operation: "initialize" }
    | { operation: "start-thread"; request: StartThreadRequest }
    | { operation: "start-objective"; request: StartObjectiveRequest }
    | { operation: "close" }
  > = [];

  constructor(private readonly failure?: ScriptedFailure) {}

  async initialize(): Promise<void> {
    this.calls.push({ operation: "initialize" });
    if (this.failure === "initialize") {
      throw new Error("scripted initialize failure");
    }
  }

  async startThread(request: StartThreadRequest): Promise<ThreadHandle> {
    this.calls.push({ operation: "start-thread", request });
    if (`${request.role}-thread` === this.failure) {
      throw new Error(`scripted ${request.role} thread failure`);
    }
    return {
      threadId: `thread-${request.role}`,
      mcpReady: this.failure !== "mcp",
    };
  }

  async startObjective(request: StartObjectiveRequest): Promise<{ turnId: string }> {
    this.calls.push({ operation: "start-objective", request });
    if (this.failure === "writer-objective") {
      throw new Error("scripted Writer Objective failure");
    }
    return { turnId: "turn-writer-objective" };
  }

  async close(): Promise<void> {
    this.calls.push({ operation: "close" });
    if (this.failure === "close") {
      throw new Error("scripted close failure");
    }
  }
}
