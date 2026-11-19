# Plan

Parked work and open questions. What's done is in the git log and in `docs/`.

## Later: model for the single-job stall check

`stuckJobs` reports any job unfinished longer than a fixed `stuckMs`, whatever the pipeline normally takes. Instead, compare the job with its duration in recent successful runs, and only when it's clearly past that, ask the model the same stuck-or-slow question the phase limit uses (`stallPrompt`). Wait until the phase-limit stall check has been seen working live.

## Not yet seen live

Covered by tests; note the result here when it happens.

- Automatic starts after `gh pr create` and after `git push` to a branch with a PR.
- New-comment events from collaborators.
- `gh workflow run` watches (gh prints no run id, so they rely on the run lookup).
- A repo where every workflow is judged `other` (the watch asks the agent to name the deploy workflow).
- The stall check at a time limit, and the model's diagnosis of a real failure.

## Gaps

- Trigger, unwatch and delivery wiring in `index.ts` has no tests of its own; the decisions are in `core/`, but the wiring around them isn't covered.
- A repo with no push runs at all waits out the 15-minute grace after a merge unless its deploy workflow is set to `"none"`.
- Bot PRs whose update is split across several PRs: the diagnosis names the companion PR, but the root fix (grouping the updates in the bot's config) is outside the plugin.
