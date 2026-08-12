# Use one Writer and one Adviser

The first Mesh will run one write-capable Writer and one read-only Adviser against the same Repository working tree. Allowing two writers would require file claims, isolated worktrees, or merge semantics that the communication prototype does not yet provide, while making both Agents read-only would fail to demonstrate a useful autonomous handoff.
