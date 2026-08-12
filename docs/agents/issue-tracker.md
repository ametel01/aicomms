# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Repository resolution

Infer the GitHub repository from `git remote -v`. If the checkout has no GitHub remote, stop and ask the Operator to add or identify one. Do not guess a repository or create one implicitly.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so resolve a bare issue number with `gh pr view <number>` and fall back to `gh issue view <number>`.

## When a skill says “publish to the issue tracker”

Create a GitHub issue.

## When a skill says “fetch the relevant ticket”

Run `gh issue view <number> --comments`.

## Wayfinding operations

- **Map**: A single issue labelled `wayfinder:map`.
- **Child ticket**: A GitHub sub-issue linked to the map. Where sub-issues are unavailable, use a task-list entry in the map and put `Part of #<map>` in the child body.
- **Blocking**: Use GitHub native issue dependencies. Where unavailable, put `Blocked by: #<n>, #<n>` at the top of the child body.
- **Frontier query**: Select the first open, unassigned child in map order whose blockers are closed.
- **Claim**: `gh issue edit <number> --add-assignee @me`
- **Resolve**: Comment with the answer, close the issue, and append a context pointer to the map’s Decisions-so-far.
