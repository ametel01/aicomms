import type {
  AppServerAdapter,
  HandlingCompletion,
  HandlingHandle,
  OperatorWaitListener,
  OperatorWaitRequest,
  OperatorWaitResponse,
  StartHandlingRequest,
  StartNoticeRequest,
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
    | { operation: "start-notice"; request: StartNoticeRequest }
    | { operation: "resume-thread"; threadId: string }
    | { operation: "respond-operator-wait"; requestId: string; response: OperatorWaitResponse }
    | { operation: "interrupt-turn"; threadId: string; turnId: string }
    | { operation: "close" }
  > = [];
  statusSubscriptionCount = 0;
  readonly #statusListeners = new Set<ThreadStatusListener>();
  readonly #operatorWaitListeners = new Set<OperatorWaitListener>();
  #handlingCompletion: ReturnType<typeof Promise.withResolvers<HandlingCompletion>> | undefined;
  #nextHandlingFailure: ScriptedFailure | undefined;
  #waitOnNextHandlingStart: OperatorWaitRequest | undefined;
  #operatorResponseObserver: (() => Promise<void>) | undefined;
  #nextOperatorResponseFailure: string | undefined;
  #handlingStartGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;

  constructor(private readonly failure?: ScriptedFailure) {}

  threadRequests(): StartThreadRequest[] {
    return this.calls.flatMap((call) => (call.operation === "start-thread" ? [call.request] : []));
  }

  emitThreadStatus(threadId: string, status: ThreadStatus): void {
    for (const listener of this.#statusListeners) {
      listener(threadId, status);
    }
  }

  emitOperatorWait(request: OperatorWaitRequest): void {
    for (const listener of this.#operatorWaitListeners) {
      listener(request);
    }
  }

  waitOnNextHandlingStart(request: OperatorWaitRequest): void {
    this.#waitOnNextHandlingStart = request;
  }

  observeOperatorResponse(observer: () => Promise<void>): void {
    this.#operatorResponseObserver = observer;
  }

  failNextOperatorResponse(message: string): void {
    this.#nextOperatorResponseFailure = message;
  }

  holdHandlings(): void {
    this.#handlingCompletion = Promise.withResolvers<HandlingCompletion>();
  }

  holdHandlingStarts(): void {
    this.#handlingStartGate = Promise.withResolvers<void>();
  }

  releaseHandlingStart(): void {
    this.#handlingStartGate?.resolve();
    this.#handlingStartGate = undefined;
  }

  completeHandling(finalOutput?: string): void {
    this.#handlingCompletion?.resolve(finalOutput === undefined ? {} : { finalOutput });
  }

  failNextHandling(failure: "handling-rejected" | "handling-start" | "handling-completion"): void {
    this.#nextHandlingFailure = failure;
  }

  handlingRequests(): StartHandlingRequest[] {
    return this.calls.flatMap((call) =>
      call.operation === "start-handling" ? [call.request] : [],
    );
  }

  noticeRequests(): StartNoticeRequest[] {
    return this.calls.flatMap((call) => (call.operation === "start-notice" ? [call.request] : []));
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
    const failure = this.#nextHandlingFailure ?? this.failure;
    this.#nextHandlingFailure = undefined;
    if (this.#waitOnNextHandlingStart) {
      this.emitOperatorWait(this.#waitOnNextHandlingStart);
      this.#waitOnNextHandlingStart = undefined;
    }
    await this.#handlingStartGate?.promise;
    if (failure === "handling-start") {
      throw new HandlingStartError("scripted ambiguous acceptance", "uncertain");
    }
    if (failure === "handling-rejected") {
      throw new HandlingStartError("scripted definite rejection", "rejected");
    }
    if (failure === "handling-disconnect") {
      throw new HandlingStartError("scripted disconnect", "uncertain");
    }
    if (failure === "handling-timeout") {
      throw new HandlingStartError("scripted timeout", "uncertain");
    }
    return {
      turnId: "turn-handling-1",
      completed:
        failure === "handling-completion"
          ? Promise.reject(new Error("scripted Handling completion failure"))
          : (this.#handlingCompletion?.promise ?? Promise.resolve({ finalOutput: "Handled." })),
    };
  }

  async startNotice(request: StartNoticeRequest): Promise<HandlingHandle> {
    this.calls.push({ operation: "start-notice", request });
    return { turnId: "turn-notice-1", completed: Promise.resolve({}) };
  }

  async resumeThread(threadId: string): Promise<void> {
    this.calls.push({ operation: "resume-thread", threadId });
    if (this.failure === "resume-thread") {
      throw new Error("scripted thread resume failure");
    }
  }

  async respondToOperatorWait(requestId: string, response: OperatorWaitResponse): Promise<void> {
    this.calls.push({ operation: "respond-operator-wait", requestId, response });
    await this.#operatorResponseObserver?.();
    if (this.#nextOperatorResponseFailure) {
      const failure = this.#nextOperatorResponseFailure;
      this.#nextOperatorResponseFailure = undefined;
      throw new Error(failure);
    }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.calls.push({ operation: "interrupt-turn", threadId, turnId });
    const completion = this.#handlingCompletion;
    this.#handlingCompletion = undefined;
    completion?.reject(new Error("scripted Handling interruption"));
  }

  onThreadStatusChanged(listener: ThreadStatusListener): () => void {
    this.statusSubscriptionCount += 1;
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onOperatorWait(listener: OperatorWaitListener): () => void {
    this.#operatorWaitListeners.add(listener);
    return () => this.#operatorWaitListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.calls.push({ operation: "close" });
    if (this.failure === "close") {
      throw new Error("scripted close failure");
    }
  }
}
