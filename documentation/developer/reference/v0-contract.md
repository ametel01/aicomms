# Confirmed v0 contract

This reference defines the required behavior of the first `codex-meshd` prototype. Terms use the canonical language in [CONTEXT.md](../../../CONTEXT.md); rationale is recorded in the [architecture decision records](../../../docs/adr/).

## Product boundary

- `codex-meshd` is a Codex-specific, local-first Supervisor, not a general-purpose multi-agent runtime.
- It coordinates peer Agents in independent top-level Codex threads. It is not a second subagent orchestrator.
- One Mesh contains one Repository, one Supervisor, one Writer, and one Adviser.
- The trust boundary is one OS user on one machine. Message content remains untrusted.
- The Supervisor creates and owns one Codex app-server process and both participating threads.
- Arbitrary existing sessions, remote peers, cross-Repository routing, durable Agent identity, and restart recovery are excluded.

## Prototype technology

- The Supervisor is implemented in TypeScript on Node.js.
- The Supervisor starts Codex app-server as an owned child over its default stdio transport.
- The authoritative Transcript is stored in SQLite.
- The protocol baseline is Codex CLI 0.147.0 with checked-in, version-matched app-server schemas.
- Startup fails if the initialization handshake or any required method or field is unavailable.

Required app-server operations include `thread/start`, `thread/resume`, `turn/start`, and `turn/interrupt`. The Supervisor does not use `turn/steer` for Message delivery.

## Repository identity

The Supervisor resolves `git rev-parse --path-format=absolute --git-common-dir`, canonicalizes symlinks, and hashes the resulting path for internal Repository identity. Startup outside a Git Repository is rejected. Remote URLs and working-directory paths are not Repository identities.

## Mesh Configuration

A checked-in Mesh Configuration declares exactly two Agents:

- One `writer`, which may modify the shared working tree.
- One `adviser`, which is read-only.

Each declaration contains a Repository-unique Agent Name, fixed Objective, role, model options, trusted instructions, and descriptive Capabilities. Capabilities never grant authority. Runtime Agent IDs and Agent Credentials are generated when the Mesh Run starts.

Configuration with duplicate Agent Names, two Writers, or a missing role is invalid. Configuration and trusted instructions are loaded before startup validation.

## Atomic startup

Before either Agent works, the Supervisor validates:

1. Mesh Configuration and configured limits.
2. Repository identity.
3. SQLite permissions and migrations.
4. Codex version and app-server schema compatibility.
5. App-server initialization.
6. Both managed threads.
7. Both Agent MCP connections.
8. The Writer and Adviser sandbox distinction.

The Supervisor injects the current public roster, then starts only the Writer's initial Objective turn. The Adviser remains idle until it receives a Message.

## Agent registration and discovery

An Agent is exactly one managed Codex thread. Replacing its thread creates a new Agent ID.

Registration records include:

- Agent ID.
- Agent Name.
- Managed thread ID.
- Repository identity.
- Fixed Objective.
- Role.
- Descriptive Capabilities.
- Lifecycle status.

`agents.list` and `agents.inspect` expose Agent ID, Agent Name, role, Objective, Capabilities, and current lifecycle status. They never expose trusted instructions, Agent Credentials, environment variables, sandbox internals, or private turn history.

An idle Agent remains registered until the Operator stops it, its managed thread closes, or the Supervisor observes a terminal system error. Lifecycle status is derived from app-server events rather than polling heartbeats.

## Agent-facing MCP interface

The v0 interface contains four non-blocking tools:

- `agents.list()` lists discoverable Agents.
- `agents.inspect(agent_id)` reads one Agent's public registration data.
- `agents.send(agent_id, body, context?)` submits a Notification and immediately returns its Message ID.
- `agents.ask(agent_id, body, context?)` submits a Question and immediately returns its Message ID.

There is no `reply`, `broadcast`, `claim`, or `release` tool in v0. A Question's Reply is delivered later in a fresh turn.

Each managed thread receives a separate stdio MCP adapter. The Supervisor supplies that adapter's Agent ID and Agent Credential through its process environment. The adapter authenticates to a private, owner-only Unix socket and forwards tool requests to the Supervisor; it never accesses SQLite directly.

The Supervisor derives the caller from the authenticated connection. Tool arguments cannot specify or override sender identity, Conversation identity, or hop counts.

## Message contract

A Message is immutable and contains:

- Unique Message ID.
- Kind: `notification`, `question`, or `reply`.
- Sender and recipient Agent IDs.
- Conversation ID.
- Creation time.
- UTF-8 body, limited to 32 KiB.
- Optional subject, limited to 200 characters.
- Optional `in_reply_to` Message ID.
- Up to 32 normalized Repository-relative file references.
- Optional Git commit ID.
- Optional worktree fingerprint calculated by the sender's adapter.

File references cannot traverse outside the Repository. The Supervisor never attaches file contents, diffs, hidden reasoning, or complete transcripts automatically. Git evidence never authorizes a checkout or other Repository mutation.

A Notification requests no Reply. A Question requests exactly one correlated Reply. A Reply answers one Question in the same Conversation.

Calls to `agents.send` or `agents.ask` during a Handling inherit its Conversation. Calls from the Writer's initial Objective turn start a new Conversation. An Agent cannot reset a causal chain by supplying a new Conversation ID.

## Delivery and Handling

- If the recipient is idle, the Supervisor starts a fresh turn containing one Message.
- If the recipient has an active turn, the Supervisor queues the Message.
- If the managed thread is unloaded, the Supervisor resumes it before starting the Handling turn.
- Queued Messages are delivered one at a time in FIFO Supervisor-acceptance order.
- Messages are never injected into an active turn.
- Only the Operator may interrupt an active turn.

The Supervisor attempts each Message injection at most once. An outcome that cannot prove acceptance becomes `ambiguous`; the Supervisor never automatically repeats it. An intentional retry creates a new Message.

When an Agent handles a Question, its final assistant output becomes the correlated Reply. When it handles a Notification or Reply, final output is recorded but not routed. A Question Handling that produces no final assistant message fails the Conversation and creates a Supervisor Notice for the asker; intermediate reasoning and tool output are never used as a Reply.

A Supervisor Notice reports control-plane failures, cancellation, expiration, or limits. It is not an Agent Message and never impersonates a peer.

## State models

Message Delivery uses:

```text
accepted → queued → injecting → injected
```

Terminal alternatives are `ambiguous`, `rejected`, `expired`, and `cancelled`.

Recipient Handling uses:

```text
starting → active → completed
```

Terminal alternatives are `failed` and `interrupted`.

Conversation uses:

```text
open → completed
```

Terminal alternatives are `failed`, `expired`, `cancelled`, and `limit_reached`.

A Conversation completes only after every accepted Message has a terminal Delivery, every injected Message has a terminal Handling, every Question has exactly one Reply, and every Reply has been handled by its recipient.

Late outcomes remain in the Transcript but are not injected after their Conversation becomes terminal. A terminal Conversation never reopens implicitly.

## Limits and duplicate detection

Default per-Conversation limits are:

- Four Agent-triggering Messages.
- Eight total Messages.
- Five minutes elapsed time.

The deadline pauses while a Handling waits for Operator approval or input. Only the Operator may change limits.

The queue permits at most 32 Messages for one Agent and 128 Messages across the Mesh. Excess work is rejected explicitly before acceptance and is never silently dropped.

The Supervisor rejects duplicate Message IDs and repeated sender-recipient-body hashes within a Conversation.

## Operator controls

The v0 CLI lets the Operator:

- Start the two-Agent harness.
- Inspect Agents, Conversations, Messages, and states.
- Follow structured logs and the Transcript.
- Approve, answer, or reject Codex requests.
- Cancel a Conversation.
- Stop the Supervisor.

The Supervisor never approves automatically. Approval or input waits are surfaced to the Operator and pause the Conversation deadline until resolved.

Cancelling a Conversation rejects new Messages, cancels queued Deliveries, and interrupts only an active Handling belonging to that Conversation. It preserves completed work and cannot undo filesystem or external effects.

## Transcript and local data

SQLite is authoritative for Agent registrations, Mesh Runs, Messages, Conversations, Delivery states, Handling states, Supervisor Notices, and correlated Codex turn IDs. Codex thread history is not the communication ledger.

The database and private socket live in Repository-local ignored state with owner-only permissions. The Transcript remains until the Operator explicitly purges it. File contents are never persisted automatically.

## Failure and shutdown

If app-server exits unexpectedly, the Supervisor:

1. Marks in-progress injections ambiguous.
2. Fails open Conversations.
3. Records Supervisor Notices.
4. Stops the Mesh without automatically restarting app-server.

When startup finds a prior nonterminal Mesh Run, it marks that run and its open Conversations failed with reason `supervisor_lost`, preserves the Transcript, and creates new threads and Agent IDs. It never resumes or reinjects old Messages.

On an Operator stop, the Supervisor stops accepting Messages, cancels queued Deliveries, interrupts active Handlings, waits briefly for acknowledgements, closes MCP connections and app-server, persists final states, and exits. It does not archive or delete Codex threads or purge the Transcript.

## Acceptance scenario

The prototype passes when an automated test demonstrates all of the following:

1. The Writer asks the Adviser to inspect a specific design flaw.
2. The Supervisor activates the idle Adviser without polling or human delivery.
3. The Adviser's final output becomes a Reply.
4. The Supervisor delivers the Reply to the Writer in a fresh turn.
5. The Writer applies and verifies one bounded Repository change.
6. The Transcript contains the correlated Messages, Deliveries, Handlings, Conversation, and Codex turn IDs.
7. No Adviser write occurs.
8. No Agent polls, no person forwards a Message, and all configured limits remain enforced.
