# Plan

Parked work and open questions. What's done is in the git log and in `docs/`.

## To evaluate: shorter progress messages

- **Now:** the whole track goes into the session as a progress message (expected deploy jobs, requested reviewers, run approvals), about 100–150 tokens each. A change to a static detail also counts as progress.
- **Alternative:** progress counts only when a stage changes state or a running stage's "x/y · job" changes, and the message leaves out the details of waiting and upcoming stages ("Checks ✓ · Review ⏸ · Merge · Deploy"). The panel keeps the full details on hover.
- **Decide after using the long version for a while:** is it too chatty, and does the agent use the details?

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
