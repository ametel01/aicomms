import type {
  AppServerAdapter,
  HandlingCompletion,
  HandlingHandle,
  StartHandlingRequest,
  StartObjectiveRequest,
  StartThreadRequest,
  ThreadHandle,
  ThreadStatus,
  ThreadStatusListener,
} from "../../src/app-server.ts";
import { HandlingStartError } from "../../src/app-server.ts";

export type ScriptedFailure =
  | "initialize"
  | "writer-thread"
  | "adviser-thread"
  | "mcp"
  | "writer-objective"
  | "handling-start"
  | "handling-rejected"
  | "handling-disconnect"
  | "handling-timeout"
  | "handling-completion"
  | "resume-thread"
  | "close";

export class ScriptedAppServer implements AppServerAdapter {
  readonly calls: Array<
    | { operation: "initialize" }
    | { operation: "start-thread"; request: StartThreadRequest }
    | { operation: "start-objective"; request: StartObjectiveRequest }
    | { operation: "start-handling"; request: StartHandlingRequest }
    | { operation: "resume-thread"; threadId: string }
    | { operation: "close" }
  > = [];
  statusSubscriptionCount = 0;
  readonly #statusListeners = new Set<ThreadStatusListener>();
  #handlingCompletion: ReturnType<typeof Promise.withResolvers<HandlingCompletion>> | undefined;

  constructor(private readonly failure?: ScriptedFailure) {}

  threadRequests(): StartThreadRequest[] {
    return this.calls.flatMap((call) => (call.operation === "start-thread" ? [call.request] : []));
  }

  emitThreadStatus(threadId: string, status: ThreadStatus): void {
    for (const listener of this.#statusListeners) {
      listener(threadId, status);
    }
  }

  holdHandlings(): void {
    this.#handlingCompletion = Promise.withResolvers<HandlingCompletion>();
  }

  completeHandling(finalOutput?: string): void {
    this.#handlingCompletion?.resolve(finalOutput === undefined ? {} : { finalOutput });
  }

  handlingRequests(): StartHandlingRequest[] {
    return this.calls.flatMap((call) =>
      call.operation === "start-handling" ? [call.request] : [],
    );
  }

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

  async startHandling(request: StartHandlingRequest): Promise<HandlingHandle> {
    this.calls.push({ operation: "start-handling", request });
    if (this.failure === "handling-start") {
      throw new HandlingStartError("scripted ambiguous acceptance", "uncertain");
    }
    if (this.failure === "handling-rejected") {
      throw new HandlingStartError("scripted definite rejection", "rejected");
    }
    if (this.failure === "handling-disconnect") {
      throw new HandlingStartError("scripted disconnect", "uncertain");
    }
    if (this.failure === "handling-timeout") {
      throw new HandlingStartError("scripted timeout", "uncertain");
    }
    return {
      turnId: "turn-handling-1",
      completed:
        this.failure === "handling-completion"
          ? Promise.reject(new Error("scripted Handling completion failure"))
          : (this.#handlingCompletion?.promise ?? Promise.resolve({ finalOutput: "Handled." })),
    };
  }

  async resumeThread(threadId: string): Promise<void> {
    this.calls.push({ operation: "resume-thread", threadId });
    if (this.failure === "resume-thread") {
      throw new Error("scripted thread resume failure");
    }
  }

  onThreadStatusChanged(listener: ThreadStatusListener): () => void {
    this.statusSubscriptionCount += 1;
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.calls.push({ operation: "close" });
    if (this.failure === "close") {
      throw new Error("scripted close failure");
    }
  }
}
