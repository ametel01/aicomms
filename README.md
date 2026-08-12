# codex-meshd

`codex-meshd` is a proposed local Supervisor for autonomous communication between peer Codex Agents. It owns their Codex app-server threads, routes Messages without Agent polling, and keeps the Operator in control without making the Operator deliver each Message.

> **Status:** implementation in progress. The Supervisor Interface validates startup and exercises
> atomic two-Agent lifecycle behavior with a scripted app-server Adapter and durable SQLite state.
> Managed threads receive authenticated stdio MCP adapters for public Agent discovery. The Operator
> CLI does not yet connect to a real Codex app-server or route Messages.

## Confirmed v0

The first prototype is deliberately narrow:

- One local Supervisor and one Git Repository.
- Two Supervisor-created Codex threads: one Writer and one read-only Adviser.
- A non-blocking `agents.*` MCP interface for discovery, Notifications, and Questions.
- FIFO Message delivery in fresh turns, with no mid-turn steering.
- A Supervisor-owned SQLite Transcript and explicit loop, queue, deadline, and authority boundaries.
- No remote peers, arbitrary-session attachment, multiple writers, or crash recovery.

The target proof is a fully automatic Writer → Adviser → Writer exchange that produces and verifies a bounded Repository change without Agent polling, human message delivery, or Adviser writes.

## Documentation

- [Documentation index](documentation/README.md)
- [Confirmed v0 contract](documentation/developer/reference/v0-contract.md)
- [Domain language](CONTEXT.md)
- [Architecture decision records](docs/adr/)

The design targets the Codex app-server protocol shipped with Codex CLI 0.147.0. The app-server interface is experimental, so runtime compatibility must be validated before a Mesh starts. See the [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
