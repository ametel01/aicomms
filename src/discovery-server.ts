import { timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerLaunch } from "./app-server.ts";
import type { PublicAgent } from "./startup-validation.ts";

interface AgentAuthentication {
  agentId: string;
  credential: string;
}

export interface SendNotificationInput {
  recipientAgentId: string;
  body: string;
  context?: {
    subject?: string;
    fileReferences?: string[];
    gitCommitId?: string;
    worktreeFingerprint?: string;
  };
}

export interface DiscoveryOperations {
  sendNotification(callerAgentId: string, input: SendNotificationInput): Promise<string>;
}

type DiscoveryRequest =
  | { id: number; operation: "authenticate"; agentId: string; credential: string }
  | { id: number; operation: "list" }
  | { id: number; operation: "inspect"; agentId: string }
  | { id: number; operation: "send"; input: SendNotificationInput };

interface DiscoveryResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class DiscoveryServer {
  readonly #sockets = new Set<Socket>();

  private constructor(
    readonly socketPath: string,
    private readonly server: Server,
    private readonly authentications: Map<string, string>,
    private readonly agents: PublicAgent[],
    private readonly operations: DiscoveryOperations,
  ) {}

  static async start(
    repositoryRoot: string,
    authentications: AgentAuthentication[],
    agents: PublicAgent[],
    operations: DiscoveryOperations,
  ): Promise<DiscoveryServer> {
    const socketPath = join(repositoryRoot, ".codex-meshd", "supervisor.sock");
    await rm(socketPath, { force: true });
    const authenticationMap = new Map(
      authentications.map(({ agentId, credential }) => [agentId, credential]),
    );
    let discovery: DiscoveryServer | undefined;
    const server = createServer((socket) => discovery?.accept(socket));
    discovery = new DiscoveryServer(socketPath, server, authenticationMap, agents, operations);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await chmod(socketPath, 0o600);
      return discovery;
    } catch (cause) {
      server.close();
      await rm(socketPath, { force: true });
      throw cause;
    }
  }

  launchFor(agentId: string, credential: string): McpServerLaunch {
    const modulePath = fileURLToPath(import.meta.url);
    const adapterFilename = extname(modulePath) === ".ts" ? "mcp-adapter.ts" : "mcp-adapter.js";
    return {
      transport: "stdio",
      command: process.execPath,
      args: [join(dirname(modulePath), adapterFilename)],
      env: {
        CODEX_MESHD_AGENT_ID: agentId,
        CODEX_MESHD_AGENT_CREDENTIAL: credential,
        CODEX_MESHD_SOCKET: this.socketPath,
      },
    };
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    this.authentications.clear();
    await rm(this.socketPath, { force: true });
  }

  private accept(socket: Socket): void {
    this.#sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let callerAgentId: string | undefined;
    socket.on("close", () => this.#sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          break;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let request: DiscoveryRequest;
        try {
          request = JSON.parse(line) as DiscoveryRequest;
        } catch {
          socket.destroy();
          return;
        }
        void this.handle(request, callerAgentId).then((response) => {
          if (request.operation === "authenticate" && response.ok) {
            callerAgentId = request.agentId;
          }
          socket.write(`${JSON.stringify(response)}\n`);
          if (request.operation === "authenticate" && !response.ok) {
            socket.end();
          }
        });
      }
    });
  }

  private async handle(
    request: DiscoveryRequest,
    callerAgentId: string | undefined,
  ): Promise<DiscoveryResponse> {
    if (request.operation === "authenticate") {
      if (callerAgentId) {
        return { id: request.id, ok: false, error: "Connection is already authenticated." };
      }
      const expected = this.authentications.get(request.agentId);
      return expected && equalSecret(expected, request.credential)
        ? { id: request.id, ok: true, result: { agentId: request.agentId } }
        : { id: request.id, ok: false, error: "Agent authentication failed." };
    }
    if (!callerAgentId) {
      return { id: request.id, ok: false, error: "Agent authentication is required." };
    }
    if (request.operation === "list") {
      return { id: request.id, ok: true, result: this.agents.map(publicRegistration) };
    }
    if (request.operation === "send") {
      try {
        const messageId = await this.operations.sendNotification(callerAgentId, request.input);
        return { id: request.id, ok: true, result: { message_id: messageId } };
      } catch (cause) {
        return {
          id: request.id,
          ok: false,
          error: cause instanceof Error ? cause.message : "Notification was rejected.",
        };
      }
    }
    const agent = this.agents.find((candidate) => candidate.id === request.agentId);
    return agent
      ? { id: request.id, ok: true, result: publicRegistration(agent) }
      : { id: request.id, ok: false, error: "Agent was not found." };
  }
}

function equalSecret(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function publicRegistration(agent: PublicAgent): Omit<PublicAgent, "threadId"> {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    objective: agent.objective,
    capabilities: [...agent.capabilities],
    status: agent.status,
  };
}
