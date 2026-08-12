# codex-meshd

`codex-meshd` is a proposed local Supervisor for autonomous communication between peer Codex Agents. It owns their Codex app-server threads, routes Messages without Agent polling, and keeps the Operator in control without making the Operator deliver each Message.

> **Status:** implementation in progress. The Supervisor Interface validates startup and exercises
> atomic two-Agent lifecycle behavior with a scripted app-server Adapter and durable SQLite state.
> Managed threads receive authenticated stdio MCP adapters for public discovery and FIFO
> Notification delivery with durable outcomes. Questions now complete asynchronously through a
> correlated Reply turn, with deferred failures delivered as Supervisor Notices. Message input,
> Repository paths, authenticated identity, and fixed role authority are enforced at the Agent
> boundary. Causal Conversations enforce duplicate, Message-count, and five-minute deadline
> controls without reopening terminal work. Operator Requests pause those deadlines until an
> explicit response, and selected Conversations can be cancelled without stopping unrelated work.
> Unexpected app-server loss fails open work without replay, while the next startup terminalizes
> stale Mesh evidence as `supervisor_lost` before creating fresh Agent and thread identities.
> The Operator CLI does not yet connect to a real Codex app-server.

## Confirmed v0

The first prototype is deliberately narrow:

- One local Supervisor and one Git Repository.
- Two Supervisor-created Codex threads: one Writer and one read-only Adviser.
- A non-blocking `agents.*` MCP interface for discovery, Notifications, and Questions.
- FIFO Message delivery in fresh turns, with no mid-turn steering.
- A Supervisor-owned SQLite Transcript and explicit loop, queue, deadline, and authority boundaries.
- No remote peers, arbitrary-session attachment, multiple writers, or crash recovery.

The target proof is a fully automatic Writer → Adviser → Writer exchange that produces and verifies a bounded Repository change without Agent polling, human message delivery, or Adviser writes.

## Operator controls

The Operator-facing CLI surface includes:

The `start` result includes a per-run Operator credential. Supply it through
`CODEX_MESHD_OPERATOR_CREDENTIAL` (or `--operator-credential`) for control commands; Agent MCP
adapters receive distinct credentials and cannot use Operator operations.

- `codex-meshd requests --cwd <repository> [--mesh-run <id>]` to list durable approval and input requests.
- `codex-meshd respond --cwd <repository> --mesh-run <id> --request <id> --decision approved|denied` for approvals.
- `codex-meshd respond --cwd <repository> --mesh-run <id> --request <id> --answer <text>` for requested input.
- `codex-meshd cancel --cwd <repository> --mesh-run <id> --conversation <id>` to cancel one Conversation. Cancellation cannot undo completed filesystem or external effects.

## Documentation

- [Documentation index](documentation/README.md)
- [Confirmed v0 contract](documentation/developer/reference/v0-contract.md)
- [Domain language](CONTEXT.md)
- [Architecture decision records](docs/adr/)

The design targets the Codex app-server protocol shipped with Codex CLI 0.147.0. The app-server interface is experimental, so runtime compatibility must be validated before a Mesh starts. See the [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
