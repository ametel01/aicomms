# Agent Mesh

The Agent Mesh context describes autonomous, local coordination among peer coding agents working within one repository under human control.

## Language

**Agent**:
A peer participant with its own objective and lifecycle.
_Avoid_: Worker, subagent, bot

**Writer**:
The sole Agent in the first Mesh permitted to modify the shared Repository working tree.
_Avoid_: Primary Agent, implementer, worker

**Adviser**:
The read-only Agent in the first Mesh that contributes evidence, review, and recommendations without modifying the shared Repository working tree.
_Avoid_: Reviewer, helper, subagent

**Agent Name**:
The Operator-chosen, Repository-unique label used to recognize an Agent within one Mesh run.
_Avoid_: Agent ID, role, thread name

**Agent ID**:
The opaque identity generated for one Agent when a Mesh starts and bound to that Agent's communication connection.
_Avoid_: Agent Name, thread ID, sender argument

**Capability**:
A descriptive claim about work an Agent is suited to perform. It never grants authority.
_Avoid_: Permission, role, credential

**Agent Credential**:
The secret issued by the Supervisor to authorize one Agent's communication connection.
_Avoid_: Capability, Agent ID, API key

**Mesh**:
The set of Agents coordinated within a single Repository boundary.
_Avoid_: Cluster, network, swarm

**Mesh Run**:
One Supervisor lifetime for a Mesh, with its own Agents and terminal outcome.
_Avoid_: Session, process, Conversation

**Supervisor**:
The local coordinator responsible for the Mesh and its participant lifecycles.
_Avoid_: Broker, orchestrator, agent

**Operator**:
The human who observes and controls the Mesh.
_Avoid_: Administrator, user, supervisor

**Repository**:
The canonical source-control boundary within which Agents may discover and communicate with one another.
_Avoid_: Workspace, project, working directory

**Mesh Configuration**:
The Operator-authored declaration of the Agents, roles, Objectives, and trusted instructions required for one Mesh.
_Avoid_: Registry, manifest, runtime state

**Objective**:
The Operator-authorized outcome that bounds an Agent's work.
_Avoid_: Prompt, job, instruction

**Message**:
A uniquely identified, immutable unit of coordination sent between Agents that carries information but no authority. A Message is a Notification, Question, or Reply.
_Avoid_: Prompt, command, event

**Notification**:
A Message that shares information without requesting a Reply.
_Avoid_: Send, announcement, event

**Question**:
A Message that requests a correlated Reply from its recipient.
_Avoid_: Ask, request, prompt

**Reply**:
A Message that answers one earlier Question within the same Conversation.
_Avoid_: Response, result, return value

**Conversation**:
A causally correlated sequence of Messages pursuing one bounded coordination exchange between Agents. Messages created during Handling remain in that Handling's Conversation.
_Avoid_: Thread, chat, session

**Delivery**:
The Supervisor's single attempt to present one Message to its recipient Agent.
_Avoid_: Retry, dispatch, send

**Handling**:
An Agent's processing of exactly one delivered Message, recorded independently from its Delivery.
_Avoid_: Turn, execution, response

**Transcript**:
The Supervisor-owned, chronological record of Messages, Deliveries, Handlings, and Conversation outcomes.
_Avoid_: Codex history, chat log, rollout

**Supervisor Notice**:
A control-plane report from the Supervisor to an Agent about routing, limits, cancellation, or another Conversation outcome. It is not a Message and never impersonates a peer Agent.
_Avoid_: System Message, synthetic Reply, error Message
