# Queue Messages for a fresh turn

When an Agent already has an active turn, the Supervisor will queue incoming Messages and deliver them in FIFO acceptance order, exactly one per fresh turn, after the Agent becomes idle instead of steering its current reasoning. This trades immediacy and batching efficiency for deterministic message boundaries, avoids disrupting unrelated work, and makes each handling outcome attributable to one Message; only the Operator may interrupt a turn.
