# Deliver Question Replies asynchronously

The `agents.ask` tool will persist a Question and return its identifier immediately instead of blocking until the recipient answers. The eventual Reply will activate the asking Agent in a fresh turn, while deferred routing or handling failures will arrive as clearly attributed Supervisor Notices rather than fabricated Replies; this avoids cross-Agent wait cycles and long-lived MCP calls at the cost of splitting a request and its answer across turns.
