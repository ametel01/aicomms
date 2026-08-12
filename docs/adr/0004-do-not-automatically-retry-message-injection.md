# Do not automatically retry Message injection

The Supervisor will attempt to inject each Message at most once and expose an ambiguous outcome when it cannot determine whether Codex accepted the turn. Because a repeated agent request could duplicate code changes or other consequential work, safety from duplicate action takes priority over guaranteed delivery; retrying requires an intentional new Message.
