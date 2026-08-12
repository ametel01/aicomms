#!/usr/bin/env bun

import { createConnection, type Socket } from "node:net";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

interface SocketResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

class SupervisorSocketClient {
  readonly #socket: Socket;
  readonly #pending = new Map<
    number,
    { resolve: (response: SocketResponse) => void; reject: (cause: Error) => void }
  >();
  #buffer = "";
  #requestId = 0;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.receive(chunk.toString()));
    socket.on("error", (cause) => this.rejectPending(cause));
    socket.on("close", () => this.rejectPending(new Error("Supervisor connection closed.")));
  }

  static async connect(
    socketPath: string,
    agentId: string,
    credential: string,
  ): Promise<SupervisorSocketClient> {
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = new SupervisorSocketClient(socket);
    const authenticated = await client.call("authenticate", { agentId, credential });
    if (!authenticated.ok) {
      socket.destroy();
      throw new Error(authenticated.error ?? "Agent authentication failed.");
    }
    return client;
  }

  async call(
    operation: "list" | "inspect" | "send",
    arguments_?: Record<string, unknown>,
  ): Promise<SocketResponse>;
  async call(
    operation: "authenticate",
    arguments_: { agentId: string; credential: string },
  ): Promise<SocketResponse>;
  async call(operation: string, arguments_: Record<string, unknown> = {}): Promise<SocketResponse> {
    const id = ++this.#requestId;
    const response = new Promise<SocketResponse>((resolve, reject) =>
      this.#pending.set(id, { resolve, reject }),
    );
    this.#socket.write(`${JSON.stringify({ id, operation, ...arguments_ })}\n`);
    return response;
  }

  close(): void {
    this.#socket.destroy();
  }

  private receive(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const response = JSON.parse(line) as SocketResponse;
      this.#pending.get(response.id)?.resolve(response);
      this.#pending.delete(response.id);
    }
  }

  private rejectPending(cause: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(cause);
    }
    this.#pending.clear();
  }
}

export async function runMcpAdapter(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const socketPath = requiredEnvironment(environment, "CODEX_MESHD_SOCKET");
  const agentId = requiredEnvironment(environment, "CODEX_MESHD_AGENT_ID");
  const credential = requiredEnvironment(environment, "CODEX_MESHD_AGENT_CREDENTIAL");
  const supervisor = await SupervisorSocketClient.connect(socketPath, agentId, credential);
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of Bun.stdin.stream()) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          break;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== "") {
          await handleJsonRpc(supervisor, JSON.parse(line) as JsonRpcRequest);
        }
      }
    }
  } finally {
    supervisor.close();
  }
}

async function handleJsonRpc(
  supervisor: SupervisorSocketClient,
  request: JsonRpcRequest,
): Promise<void> {
  if (request.id === undefined) {
    return;
  }
  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "codex-meshd-agents", version: "0.0.0" },
    });
    return;
  }
  if (request.method === "tools/list") {
    respond(request.id, { tools: toolDefinitions() });
    return;
  }
  if (request.method !== "tools/call") {
    respondError(request.id, -32601, "Method not found.");
    return;
  }
  const params = request.params;
  if (!isRecord(params) || typeof params.name !== "string" || !isRecord(params.arguments)) {
    respondError(request.id, -32602, "Invalid tool arguments.");
    return;
  }
  let response: SocketResponse;
  if (params.name === "agents.list" && Object.keys(params.arguments).length === 0) {
    response = await supervisor.call("list");
  } else if (
    params.name === "agents.inspect" &&
    Object.keys(params.arguments).length === 1 &&
    typeof params.arguments.agent_id === "string"
  ) {
    response = await supervisor.call("inspect", { agentId: params.arguments.agent_id });
  } else if (params.name === "agents.send" && validSendArguments(params.arguments)) {
    response = await supervisor.call("send", {
      input: {
        recipientAgentId: params.arguments.agent_id,
        body: params.arguments.body,
        ...(params.arguments.context === undefined
          ? {}
          : { context: normalizeContext(params.arguments.context) }),
      },
    });
  } else {
    respondError(request.id, -32602, "Invalid tool arguments.");
    return;
  }
  if (!response.ok) {
    respondError(request.id, -32000, response.error ?? "Supervisor request failed.");
    return;
  }
  respond(request.id, {
    content: [{ type: "text", text: JSON.stringify(response.result) }],
    structuredContent: { result: response.result },
  });
}

function toolDefinitions(): unknown[] {
  return [
    {
      name: "agents.list",
      description: "List the public Agent roster for this Repository.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "agents.inspect",
      description: "Inspect one public Agent registration.",
      inputSchema: {
        type: "object",
        properties: { agent_id: { type: "string" } },
        required: ["agent_id"],
        additionalProperties: false,
      },
    },
    {
      name: "agents.send",
      description: "Send a Notification to another Agent without waiting for Handling.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          body: { type: "string" },
          context: {
            type: "object",
            properties: {
              subject: { type: "string" },
              file_references: { type: "array", items: { type: "string" } },
              git_commit_id: { type: "string" },
              worktree_fingerprint: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        required: ["agent_id", "body"],
        additionalProperties: false,
      },
    },
  ];
}

function respond(id: number | string, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id: number | string, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSendArguments(arguments_: Record<string, unknown>): boolean {
  return (
    Object.keys(arguments_).every((key) => ["agent_id", "body", "context"].includes(key)) &&
    typeof arguments_.agent_id === "string" &&
    typeof arguments_.body === "string" &&
    (arguments_.context === undefined || validContext(arguments_.context))
  );
}

function validContext(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ["subject", "file_references", "git_commit_id", "worktree_fingerprint"].includes(key),
    ) &&
    (value.subject === undefined || typeof value.subject === "string") &&
    (value.file_references === undefined ||
      (Array.isArray(value.file_references) &&
        value.file_references.every((reference) => typeof reference === "string"))) &&
    (value.git_commit_id === undefined || typeof value.git_commit_id === "string") &&
    (value.worktree_fingerprint === undefined || typeof value.worktree_fingerprint === "string")
  );
}

function normalizeContext(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return {
    ...(typeof value.subject === "string" ? { subject: value.subject } : {}),
    ...(Array.isArray(value.file_references) &&
    value.file_references.every((reference) => typeof reference === "string")
      ? { fileReferences: value.file_references }
      : {}),
    ...(typeof value.git_commit_id === "string" ? { gitCommitId: value.git_commit_id } : {}),
    ...(typeof value.worktree_fingerprint === "string"
      ? { worktreeFingerprint: value.worktree_fingerprint }
      : {}),
  };
}

if (import.meta.main) {
  await runMcpAdapter().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : "MCP adapter failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
