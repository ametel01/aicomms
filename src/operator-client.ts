import { createConnection } from "node:net";
import { join } from "node:path";
import type { OperatorWaitResponse } from "./app-server.ts";
import type { CancelConversationResult } from "./supervisor.ts";
import type { OperatorRequest } from "./transcript-store.ts";

type OperatorCommand =
  | { operation: "operator-requests"; operatorCredential: string; meshRunId?: string }
  | {
      operation: "operator-respond";
      operatorCredential: string;
      meshRunId: string;
      requestId: string;
      response: OperatorWaitResponse;
    }
  | {
      operation: "operator-cancel";
      operatorCredential: string;
      meshRunId: string;
      conversationId: string;
    };

interface OperatorResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export async function listOperatorRequestsOverSocket(
  cwd: string,
  operatorCredential: string,
  meshRunId?: string,
): Promise<OperatorRequest[]> {
  return (await operatorCall(cwd, {
    operation: "operator-requests",
    operatorCredential,
    ...(meshRunId ? { meshRunId } : {}),
  })) as OperatorRequest[];
}

export async function respondToOperatorRequestOverSocket(
  cwd: string,
  operatorCredential: string,
  meshRunId: string,
  requestId: string,
  response: OperatorWaitResponse,
): Promise<OperatorRequest> {
  return (await operatorCall(cwd, {
    operation: "operator-respond",
    operatorCredential,
    meshRunId,
    requestId,
    response,
  })) as OperatorRequest;
}

export async function cancelConversationOverSocket(
  cwd: string,
  operatorCredential: string,
  meshRunId: string,
  conversationId: string,
): Promise<CancelConversationResult> {
  return (await operatorCall(cwd, {
    operation: "operator-cancel",
    operatorCredential,
    meshRunId,
    conversationId,
  })) as CancelConversationResult;
}

async function operatorCall(cwd: string, command: OperatorCommand): Promise<unknown> {
  const socket = createConnection(join(cwd, ".codex-meshd", "supervisor.sock"));
  socket.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buffer = "";
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      socket.destroy();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as OperatorResponse;
        if (!response.ok) {
          reject(new Error(response.error ?? "Operator request failed."));
          return;
        }
        resolve(response.result);
      } catch (cause) {
        reject(cause);
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, ...command })}\n`);
    });
  }).finally(() => socket.destroy());
}
