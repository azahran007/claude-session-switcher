# Claude Session Switcher

**Move a Claude Code conversation from one subscription to another, on the same
machine, and pick it up exactly where you left off.**

If you run Claude Code under more than one account — a personal plan and a work
plan, say — each lives in its own `CLAUDE_CONFIG_DIR` with its own sessions. The
CLI gives you no way to see across them: `claude --resume` lists only the current
directory, under the current account. So a conversation started on the wrong plan
is effectively stranded.

This is a small local web app that fixes that. It shows every session on the
machine in one table — across every account — lets you filter by archived state,
rename them, and hand a session to a different subscription so you can carry on
under that account's credentials.

![Node](https://img.shields.io/badge/node-%E2%89%A518-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows-blue)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

### What it does

- **One list, every account.** Sessions from every config dir, joined with the
  desktop app's own registry so you get the real titles and archived state.
- **Filter** by subscription, archived / active / unknown, running / idle, and
  free-text across title, prompt, folder, branch, and session id.
- **Move or copy** a session between subscriptions, with guards against the ways
  that can quietly destroy a transcript.
- **Rename** a session using the same mechanism Claude Code itself uses.
- **Stops itself** after 5 minutes idle, so it never becomes a stray dev server.

Zero dependencies — no `npm install`, nothing to build, nothing phones home. It
binds to `127.0.0.1` only, because it exposes your session transcripts.

### Why it isn't just a file copy

It mostly is — and that is the interesting part. A transcript carries **no
account identity**, so relocating the `.jsonl` is genuinely all it takes. But
finding the right file, knowing whether a session is archived, showing its
current name, and not corrupting a live one each require reconciling two separate
stores that Claude Code keeps in different places and links only loosely. That
reconciliation is what this repo is.

## Run

```bash
node server.js
```

Then open <http://localhost:7788>. On Windows, `start.cmd` is friendlier: it
starts the server only if the port is free, then opens your browser — so
launching it twice will not spawn a second copy.

The server **stops itself after 5 minutes idle** so you can open it, forget it,
and not leave a process running. The page heartbeats while its tab is open;
closing the tab arms a 30-second grace window (long enough to survive a reload)
and then it exits. There is also a **Quit server** button. To change or disable
the timeout:

```bash
IDLE_MINUTES=30 node server.js
```

`IDLE_MINUTES=0` disables idle shutdown entirely.

## Where the data lives

Claude Code keeps session state in two independent stores. This app joins them.

| Store | Path | Provides |
|---|---|---|
| CLI transcripts | `<configDir>/projects/<slug>/<cliSessionId>.jsonl` | conversation, cwd, prompts, size |
| Desktop registry | `%APPDATA%\Claude\claude-code-sessions\<accountUuid>\<orgUuid>\local_*.json` | title, **`isArchived`**, branch, model |
| Live processes | `<configDir>/sessions/<pid>.json` | which sessions are running right now |

`<configDir>` defaults to `~/.claude`, and is overridden by `CLAUDE_CONFIG_DIR` —
which is how one machine holds several accounts. This app scans `~/.claude`,
`~/.claude-work`, and `~/.claude-personal`.

`isArchived` exists **only** in the desktop registry. A transcript with no
registry record is reported as `unknown` rather than guessed to be active.

Transcripts are sampled (first 64 KB + last 256 KB) rather than read whole — real
ones reach tens of MB, and title records are rewritten throughout a session so the
tail always carries the current one. A full scan of ~130 sessions takes under a second.

## Subscriptions, not config directories

Sessions are grouped by **subscription** (`accountUuid`), because two config dirs
can be the same paying account — a distinction that is easy to miss and changes
what a "move" actually means. A move targets a subscription; the file lands in
that subscription's primary config dir (whichever already holds the most sessions).

The UI warns when the source and destination are different tiers, since moving to
a lower tier can change model availability and rate limits mid-conversation.

## Getting the current display name

A desktop session stores only its **current** `cliSessionId`, but compaction and
forks rotate that id — so earlier transcripts of the same conversation match
nothing by id and fall back to showing their opening prompt, which reads as a
stale name. Three joins run in order:

1. `cliSessionId` exact
2. title + cwd exact
3. **cwd + time window** — same folder, and the transcript's last write falls
   inside that desktop session's `createdAt … lastActivityAt` span

Requiring the window to *contain* the timestamp stops unrelated sessions being
glued together merely for sharing a directory. On a real machine this cut
unnamed sessions from 28 to 3 and raised archived detection from 69 to 78.

## Moving a session between accounts

A transcript contains **no account identity** — no `accountUuid`, no email, no
token. Identity lives entirely in `<configDir>/.credentials.json`. Handing a
session to another account is therefore just relocating the `.jsonl` into that
account's `projects/` tree. Verified end to end: a session created under one
account was resumed under another and correctly recalled its own history.

### Guards

Transfers refuse to run when:

- **the session is running** — a live process is appending to that file, and a second writer corrupts it
- **the destination already holds a copy** — the two have diverged; you must pick one
- source and destination are the same, or the mode is not `copy`/`move`

`move` is copy → verify byte length → unlink. The source is never removed before
the destination is confirmed intact.

## Renaming

Claude Code stores the display name as a `custom-title` record appended to the
transcript and rewritten as the session goes; the last one wins. Renaming appends
a fresh record — the native mechanism, which `claude --resume` and this app both
read immediately.

The desktop app keeps its own copy in its registry. **Editing that file while the
app is running does nothing** — it holds session state in memory and will
overwrite the change. So the registry write is skipped whenever the app is
running, and the UI says so. Quit Claude Desktop and rename again to change the
name *it* displays.

If the running-check itself fails, the app assumes Claude Desktop **is** running
and skips the write — failing safe rather than writing under a live app.

## Retention will delete sessions out from under you

Claude Code applies a default retention period and deletes old transcripts
automatically. On the machine this was built against, a cleanup pass removed an
entire account's transcripts (28 sessions) while leaving their desktop registry
entries behind — the metadata still lists them, but the conversations are gone.

To keep sessions longer, set this in `~/.claude/settings.json` (and in each other
config dir you care about):

```json
{ "cleanupPeriodDays": 3650 }
```

This app never deletes a transcript. Retention is the only thing that does.

## Layout

```
server.js          zero-dep HTTP server, API, idle shutdown
lib/scan.js        discovery — reads both stores, joins them. No writes.
lib/move.js        transfers between config dirs, with the guards above
lib/rename.js      title writes
public/index.html  the whole UI
start.cmd          Windows launcher
```

Windows-only as written: the desktop registry path and the running-app check use
Windows APIs. The transcript half is portable.

## License

MIT
