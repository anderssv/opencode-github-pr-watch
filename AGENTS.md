# AGENTS.md

OpenCode V2 plugin that watches GitHub PRs until deployed. Behaviour is documented in `docs/` (the README is a short overview that links there); keep both in sync when behaviour changes.

## Workflow

- Work directly on `main`. No branches, no PRs. There is no remote.
- Commit when a change is done and tests pass.
- Test-first: write a failing test, then the fix.
- `feedback.md` and `plan.md` are local working notes, not tracked or published (they name real repos and PRs). When they exist:
  - `feedback.md` is input from others: raw bug reports and suggestions from real use. Don't rewrite or reorder it; take items from it into `plan.md`.
  - `plan.md` is the working list: reviewed, prioritised items with conflicts resolved. Work from it, and move items to its Done section (with the commit) when fixed.

## Running

- Tests: `mise exec bun@1.4.2 -- bun test`
- Type check: `mise exec bun@1.4.2 -- bunx tsc --noEmit --strict index.ts` (no tsconfig, no lint script)
- No build step: OpenCode loads `index.ts` from source. Restart OpenCode to load changes.

## Structure

- `index.ts`: plugin entry. Wires tools, storage, polling and session messages.
- `core/`: pure logic, one concern per file (facts, policy, verdicts, messages, batching, timing, advice, listing).
- `core/runtime.ts`: process-wide state on `globalThis`.
- `tests/`: one test file per core module; test data via object mothers in `tests/mothers.ts`.

## Constraints

- OpenCode can run plugin `setup()` several times in one process (per instance or reload). Anything that must happen once per process (resume note, poll loop) goes through `core/runtime.ts`; never assume setup runs once.
- One poll loop per directory. A replaced instance must stop rescheduling and must not save results.
- Build session messages from storage at send time, never from a stale in-memory copy. Re-read the PR before sending, and drop messages the live state no longer supports.
- Keep public tool names and argument shapes stable.
- No mocking frameworks; use fakes and object mothers.
- Errors: low-level reads and model calls throw; only two kinds of boundary catch. The poll step (`step` in `index.ts`) catches whatever a check throws, logs `check-failed` and retries. `tolerate()` (`core/debug-log.ts`) wraps something the run can do without (a suggestion, an optional fact, a progress event), logs `tolerated-error` with what failed, and uses a fallback. A read that decides the facts must never fall back to an empty value (no runs reads as "no deploy started"): let it throw so the check decides nothing. Never write a bare `.catch(() => …)`. Parsing a model's answer into a defined fallback is not an error and is fine.
- Debug log: `~/.local/state/opencode-github-pr-watch/debug.jsonl` (option `debugLog`). Log each decision with the watch id; read it first when diagnosing a report.
- Model answers: each call's JSON answer is defined once in `core/` (`*_ANSWER`, read with `core/answer.ts`). The prompt's "Answer with JSON only" line is made from it with `answerShape`, and the parser reads with `readAnswer`. Decision fields are choices, booleans or numbers, with a `fallback` where the old behaviour had one; free-text fields stay free text. Parsers take `onInvalid`, which the plugin logs as `model-answer-invalid`. Don't hand-write the JSON line in a prompt.

Views and the watch lifecycle are separate: filters, grouping and the pill only choose what is shown (`core/prs-view.ts`, `core/store.ts`), and whether a watch starts, runs or ends is decided only by the lifecycle (`core/watcher.ts`, `core/policy.ts`, `core/actor.ts`). `tests/boundaries.test.ts` keeps them from importing each other.
