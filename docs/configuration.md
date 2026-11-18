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
        "desktopNotifications": true, // macOS notification with the watcher's message
        "debugLog": true, // JSON-lines debug log at ~/.local/state/opencode-github-pr-watch/debug.jsonl; false, or a path
        "bookkeepingJobs": ["detect changes", "build status"] // jobs that only detect changes or report a status in monorepos; defaults cover common names
      }
    }
  ]
}
```

If no preference matches, the session's own model is used.

## Debug log

Every decision is written as one JSON line to `~/.local/state/opencode-github-pr-watch/debug.jsonl` (rotated to `.1` at 5 MB). Set `"debugLog": false` to turn it off, or a path to write elsewhere. Events, each with the watch id:

- `command`: a shell command with a merge, rerun, branch update, bot command or dispatch, what was detected, and how long it ran.
- `start`, `start-kept`, `start-skipped`, `no-watch`, `unwatch`, `resumed`: why a watch started, continued, didn't start or stopped.
- `check`: each poll's step, phase, events and summary; `end` with the reason; `result` with stop and the next delay.
- `judge`, `diagnosis`, `bot-advice`, `stall`: each model call's answer or error.
- `model-answer-invalid`: a model answer the code couldn't fully use: which call and model, what was wrong (no JSON, a value outside the choices, a missing field), and the start of the raw answer. A wrong value in a decision field falls back (for example "notify" when judging, "real" for a failure's cause) and the model's own text is still used; useful when trying a different model.
- `notify`, `delivered`, `deliver-dropped`, `dropped`: messages sent, delivered, or dropped (unwatched, superseded, stale).
- `read-failed`: GitHub couldn't be read, so the check decided nothing. `tolerated-error`: something optional failed and was left out. `check-failed`: a check threw and will be retried.

Find one watch's history with `grep '"id":"o/r#123"' ~/.local/state/opencode-github-pr-watch/debug.jsonl`.

## Notifications

Every message is posted to the session; only some wake the agent (see [How watching works](how-it-works.md)). With `desktopNotifications` on, a message is also shown as a macOS notification (PR as title, first line as text) when someone has to act: something for the agent to fix, a person's turn (a review, a run approval, the merge), a reminder, the end of a watch, or what the model flags. Progress and ordinary changes of step only go to the session. With [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) installed (`brew install terminal-notifier`), clicking it brings the OpenCode desktop app to the front and a newer notification for the same PR replaces the older one; if it is missing or fails (for example when macOS hasn't allowed its notifications yet), `osascript` is used instead and clicking opens Script Editor. Allow notifications for terminal-notifier in System Settings → Notifications. It appears on the machine running the OpenCode background service. The quiet "Watching …" notes don't notify.
