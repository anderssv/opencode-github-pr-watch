# Configuration

## Options

```jsonc
{
  "plugins": [
    {
      "package": "opencode-github-pr-watch", // or the path to a local checkout
      "options": {
        "preferences": ["haiku", "mini", "flash"], // substrings matched against model IDs of the session's provider, in order
        "stuckMinutes": 30, // report a deploy job unfinished for longer than this
        "ghPath": "/opt/homebrew/bin/gh", // optional; gh is found on your login shell's PATH (mise shims skipped), then in /opt/homebrew/bin and /usr/local/bin
        "maxMinutes": 30, // limit when a workflow has too little history, and for auto-merge/auto-update waits
        "debugLog": true, // JSON-lines debug log at ~/.local/state/opencode-github-pr-watch/debug.jsonl; false, or a path
        "bookkeepingJobs": ["detect changes", "build status"], // jobs that only detect changes or report a status in monorepos; defaults cover common names
        "analyseComments": false // let the light model read new comments and summarise them; read the warning below first
      }
    }
  ]
}
```

If no preference matches, the session's own model is used.

## Reading comments (`analyseComments`)

Off by default. Then a new comment is said as who and where only ("new review comment by bob on src/a.ts (link)"), unresolved threads are marked on the line, and the agent reads a comment itself if it needs to.

When on, the light model reads the text of new comments (up to 10 per check) and the session gets one plain-language line for each: what kind it is (change requested, question, small suggestion, comment), what it asks in the model's words, and where it is, with a `gh api` path the agent can read it with. The agent is woken and asked to check with you whether to fix, answer or leave each.

> **Warning: consider this carefully before turning it on.** A comment is text written by someone else, and with this option its meaning reaches your agent's context, which the agent then acts on. That is the classic route for prompt injection. The plugin narrows it as far as it can: only comments from the repo's collaborators and from review bots are read; the model runs with no tools, session or history (stateless generation), is told the comments are data to describe and never instructions, and each comment is fenced so it can't break out; what comes back is cut to one plain line of at most 140 characters with links, code and markup removed; the comment's own text never reaches the session. A summary can still carry a manipulated meaning ("asks you to delete the prod environment"), so the agent is told to ask you before acting. Turn it on only for repos where everyone who can comment is trusted, and keep confirming what the agent does with comments.

## Debug log

Every decision is written as one JSON line to `~/.local/state/opencode-github-pr-watch/debug.jsonl` (rotated to `.1` at 5 MB). Set `"debugLog": false` to turn it off, or a path to write elsewhere. Events, each with the watch id:

- `command`: a shell command with a merge, rerun, branch update, bot command or dispatch, what was detected, and how long it ran.
- `start`, `start-kept`, `start-skipped`, `no-watch`, `unwatch`, `resumed`: why a watch started, continued, didn't start or stopped.
- `check`: each poll's step, phase, events and summary; `end` with the reason; `result` with stop and the next delay.
- `judge`, `diagnosis`, `bot-advice`, `stall`: each model call's answer or error.
- `model-answer-invalid`: a model answer the code couldn't fully use: which call and model, what was wrong (no JSON, a value outside the choices, a missing field), and the start of the raw answer. A wrong value in a decision field falls back (for example "notify" when judging, "real" for a failure's cause) and the model's own text is still used; useful when trying a different model.
- `github-paused`, `github-back`: every GitHub call paused for a rate limit or the network, and resumed.
- `notify`, `delivered`, `deliver-dropped`, `dropped`: messages sent, delivered, or dropped (unwatched, superseded, stale).
- `read-failed`: GitHub couldn't be read, so the check decided nothing. `tolerated-error`: something optional failed and was left out. `check-failed`: a check threw and will be retried.

Find one watch's history with `grep '"id":"o/r#123"' ~/.local/state/opencode-github-pr-watch/debug.jsonl`.

## Notifications

Only what the agent can act on is posted to the session, and it wakes the agent; everything else is shown by the pill and the PRs tab (see [How watching works](how-it-works.md#what-goes-to-the-session)).
