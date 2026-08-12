# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repository root.
- ADRs under `docs/adr/` that affect the area being changed.

If either location does not exist, proceed silently. The domain-modeling workflow creates files lazily when terms or decisions are resolved.

## File structure

This is a single-context repository:

```text
/
├── CONTEXT.md
├── docs/
│   ├── adr/
│   └── agents/
└── src/
```

## Use the glossary's vocabulary

When output names a domain concept—in an issue title, refactor proposal, hypothesis, or test name—use the term defined in `CONTEXT.md`. Avoid synonyms the glossary explicitly rejects.

If a required concept is absent, reconsider whether it belongs to the project language or note the gap for the domain-modeling workflow.

## Flag ADR conflicts

Surface contradictions with an existing ADR explicitly rather than silently overriding the decision.
