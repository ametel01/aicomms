import { afterEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { createSupervisor } from "../src/supervisor.ts";
import { McpTestClient } from "./support/mcp-client.ts";
import { TestRepository } from "./support/repository.ts";
import { ScriptedAppServer } from "./support/scripted-app-server.ts";

const testRepository = new TestRepository();

afterEach(async () => {
  await testRepository.cleanup();
});

describe("authenticated Agent discovery", () => {
  test("gives each thread a distinct authenticated stdio MCP adapter", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const appServer = new ScriptedAppServer();
    const generatedValues = ["run-1", "writer-id", "writer-secret", "adviser-id", "adviser-secret"];
    const supervisor = createSupervisor({
      appServer,
      generateOpaqueValue: () => generatedValues.shift() ?? "unexpected",
    });

    const started = await supervisor.start({ cwd, configurationPath });
    if (started.status !== "running") {
      throw new Error("Expected Mesh startup to succeed.");
    }
    const launches = appServer.threadRequests().map((request) => request.mcpServer);
    expect(launches).toHaveLength(2);
    expect(launches[0]?.transport).toBe("stdio");
    expect(launches[0]?.env.CODEX_MESHD_AGENT_ID).toBe("writer-id");
    expect(launches[1]?.env.CODEX_MESHD_AGENT_ID).toBe("adviser-id");
    expect(launches[0]?.env.CODEX_MESHD_AGENT_CREDENTIAL).toBe("writer-secret");
    expect(launches[1]?.env.CODEX_MESHD_AGENT_CREDENTIAL).toBe("adviser-secret");
    expect(launches[0]?.env.CODEX_MESHD_AGENT_CREDENTIAL).not.toBe(
      launches[1]?.env.CODEX_MESHD_AGENT_CREDENTIAL,
    );
    expect((await stat(launches[0]?.env.CODEX_MESHD_SOCKET ?? "")).mode & 0o777).toBe(0o600);
    const writerLaunch = launches[0];
    const adviserLaunch = launches[1];
    if (!writerLaunch || !adviserLaunch) {
      throw new Error("Expected two MCP launch configurations.");
    }

    const writer = McpTestClient.spawn(writerLaunch);
    const adviser = McpTestClient.spawn(adviserLaunch);
    expect((await writer.initialize()).error).toBeUndefined();
    expect((await adviser.initialize()).error).toBeUndefined();

    const tools = await writer.request("tools/list");
    expect(tools.result).toEqual({
      tools: [
        expect.objectContaining({ name: "agents.list" }),
        expect.objectContaining({ name: "agents.inspect" }),
        expect.objectContaining({ name: "agents.send" }),
        expect.objectContaining({ name: "agents.ask" }),
      ],
    });
    const list = await writer.request("tools/call", {
      name: "agents.list",
      arguments: {},
    });
    const agents = structuredContent(list) as Array<Record<string, unknown>>;
    expect(agents).toEqual(started.meshRun.agents.map(({ threadId: _, ...agent }) => agent));
    for (const agent of agents) {
      expect(agent).not.toHaveProperty("trustedInstructions");
      expect(agent).not.toHaveProperty("agentCredential");
      expect(agent).not.toHaveProperty("environment");
      expect(agent).not.toHaveProperty("sandbox");
      expect(agent).not.toHaveProperty("turnHistory");
      expect(Object.keys(agent).sort()).toEqual(
        ["capabilities", "id", "name", "objective", "role", "status"].sort(),
      );
    }

    const inspected = await adviser.request("tools/call", {
      name: "agents.inspect",
      arguments: { agent_id: "writer-id" },
    });
    const writerAgent = started.meshRun.agents[0];
    if (!writerAgent) {
      throw new Error("Expected Writer registration.");
    }
    const { threadId: _, ...expectedWriter } = writerAgent;
    expect(structuredContent(inspected)).toEqual(expectedWriter);

    await writer.close();
    await adviser.close();
    await supervisor.stop({ meshRunId: started.meshRun.id });
  });

  test("rejects spoofed sender metadata and invalid Agent Credentials", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const appServer = new ScriptedAppServer();
    const supervisor = createSupervisor({ appServer });
    const started = await supervisor.start({ cwd, configurationPath });
    if (started.status !== "running") {
      throw new Error("Expected Mesh startup to succeed.");
    }
    const launch = appServer.threadRequests()[0]?.mcpServer;
    if (!launch) {
      throw new Error("Expected an MCP launch configuration.");
    }
    const client = McpTestClient.spawn(launch);
    await client.initialize();

    const resetClient = createConnection(launch.env.CODEX_MESHD_SOCKET ?? "");
    await new Promise<void>((resolve, reject) => {
      resetClient.once("connect", resolve);
      resetClient.once("error", reject);
    });
    resetClient.destroy(new Error("scripted client reset"));

    const spoofed = await client.request("tools/call", {
      name: "agents.inspect",
      arguments: { agent_id: started.meshRun.agents[1]?.id, senderAgentId: "spoofed" },
    });
    expect(spoofed.error?.code).toBe(-32602);

    const invalidClient = McpTestClient.spawn({
      ...launch,
      env: { ...launch.env, CODEX_MESHD_AGENT_CREDENTIAL: "wrong-secret" },
    });
    await expect(invalidClient.initialize()).rejects.toThrow("exited before responding");

    await client.close();
    await invalidClient.close();
    await supervisor.stop({ meshRunId: started.meshRun.id });
  });

  test("updates public lifecycle status from app-server events", async () => {
    const cwd = await testRepository.gitRepository();
    const configurationPath = await testRepository.writeConfiguration(cwd);
    const appServer = new ScriptedAppServer();
    const supervisor = createSupervisor({ appServer });
    const started = await supervisor.start({ cwd, configurationPath });
    if (started.status !== "running") {
      throw new Error("Expected Mesh startup to succeed.");
    }
    const adviser = started.meshRun.agents.find((agent) => agent.role === "adviser");
    if (!adviser?.threadId) {
      throw new Error("Expected Adviser registration.");
    }
    appServer.emitThreadStatus(adviser.threadId, "active");

    const inspected = await supervisor.inspectMeshRun({ cwd, meshRunId: started.meshRun.id });
    expect(inspected?.agents.find((agent) => agent.id === adviser.id)?.status).toBe("working");
    expect(appServer.statusSubscriptionCount).toBe(1);

    await supervisor.stop({ meshRunId: started.meshRun.id });
  });
});

function structuredContent(response: {
  result?: unknown;
  error?: { code: number; message: string };
}): unknown {
  if (response.error) {
    throw new Error(`MCP call failed: ${response.error.message}`);
  }
  const result = response.result as { structuredContent?: { result?: unknown } } | undefined;
  return result?.structuredContent?.result;
}
