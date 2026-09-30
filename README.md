# ticket

A fast ticket queue for Claude Code agents. You register projects, add tickets to them,
and run an orchestrator that hands each ticket to its own Claude Code session until the
queue is empty. When the subscription's 5-hour window runs out, the orchestrator pauses
and resumes on its own once the window resets.

Everything runs on top of Claude Code: workers are Claude Code sessions started through
the Agent SDK. Nothing else needs to be installed.

## Install

Requires [Bun](https://bun.sh) 1.3+ and a logged-in Claude Code (`claude auth status`).

```sh
bun install
bun link            # puts `ticket` on your PATH (from src/, no build step)
# or build one binary:
bun run build       # dist/ticket (code-split: commands start in about 30-40 ms)
```

## Quick start

```sh
ticket add project "myapp" ~/code/myapp          # first project becomes the default
ticket add "fix login" "Fix the login bug in auth.ts and add a test" "model=opus effort=high priority=1 bug"
ticket add "write docs" "Write a README for the API" "docs max-turns=20"
ticket list                                      # interactive list (arrow keys)
ticket run                                       # orchestrator with a live view
ticket run --detach                              # or in the background; `ticket stop` ends it
ticket status                                    # state, counts, pause reason and resume time
ticket log "fix login" --follow                  # worker transcript
```

## Commands

| Command | What it does |
| --- | --- |
| `ticket add project "name" [path]` | Registers a project. `path` defaults to the current folder. Flags: `--model`, `--effort`, `--concurrency`, `--default`. |
| `ticket add "name" "query" ["tags"]` | Adds a ticket. `query` is the prompt the worker gets. Tags are `key=value` pairs and bare labels. |
| `ticket remove "name" [--yes]` | Deletes a ticket; a running one is stopped first. `ticket remove project "name"` deletes a project and its tickets. |
| `ticket change "name" [--name] [--query] [--tags] [--priority] [--status]` | Edits fields. No flags opens the inline editor. `--status todo` re-queues a ticket. `ticket change project "name" --path/--model/--effort/--concurrency/--default` edits a project. |
| `ticket list [project] [--plain] [--status S] [--projects] [--json]` | Interactive list; `--plain` prints a table (also when piped). |
| `ticket run [project] [--concurrency N] [--detach] [--plain]` | Starts the orchestrator. Defaults to every project. |
| `ticket pause` / `ticket resume` / `ticket stop` | Pause dispatch after current workers finish; resume early; stop a detached orchestrator. |
| `ticket status [--json]` | One screen of state. |
| `ticket log "name" [--follow] [--raw] [--run N]` | Worker transcript for a ticket. |
| `ticket plan "name" [--yes]` | Asks Claude to split a ticket into sub-tickets and adds them on approval. |

Ticket names are unique within a project. When a name exists in several projects, pass
`project=<name>`, `--project`, or `--id <n>`.

### Tags

| Key | Values | Default |
| --- | --- | --- |
| `project` | a registered project | the project whose folder contains the current directory, else the default |
| `model` | `opus`, `sonnet`, `haiku`, or a full model id | the project's default, else Claude Code's |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` | the project's default, else Claude Code's |
| `priority` | 1 (highest) to 5 | 3 |
| `max-turns` | a number | 50 |
| `permission` | `plan`, `default`, `acceptEdits`, `bypass`, `dontAsk` | `acceptEdits` |

Any other token (`bug`, `docs`, `team=core`) is stored as a label or custom tag for filtering.

## Interactive list (demo: `bun run src/tui/demo.ts`)

| Key | Action |
| --- | --- |
| ↑ / ↓, j / k | Move the cursor |
| Enter | Open the ticket (query, tags, last run, live log tail if running) |
| a / e / d | Add, edit, delete (one-key confirm) |
| r | Run the selected ticket now, ahead of the queue |
| p | Pause or resume the orchestrator |
| / | Filter by name, label or status |
| Tab | Switch project |
| q / Esc | Quit, or close the open ticket |

## How the orchestrator works

- One orchestrator per machine. It claims tickets by priority then age, up to the
  concurrency cap (`--concurrency`, default 2; a project's `--concurrency` caps that project).
- Each ticket runs as its own Claude Code session in the project folder, with model,
  effort, permission mode and max turns from its tags. Workers are told to commit on a
  branch named `ticket/<name>` and never push, and to end with one line
  `TICKET: done`, `TICKET: blocked <question>` or `TICKET: failed <reason>`.
- A failed run is retried once, then the ticket is `failed`. A worker that needs a human
  answer leaves the ticket `blocked` with the question in `ticket list` / `ticket status`.
- Rate limit: when Claude Code reports the 5-hour, weekly or Opus limit, the ticket goes to
  `paused` with its session id, dispatch stops (for Opus-only limits, only Opus tickets),
  and the orchestrator sleeps until a minute after the reset time. It then probes with a
  one-turn Haiku call and, once the window is open, resumes the paused sessions with
  `--resume` so no work is lost. An unparseable reset time means a retry every 10 minutes.
- The CLI and the orchestrator only talk through the SQLite database at
  `~/.ticket/tickets.db` (WAL mode). Worker transcripts are `~/.ticket/logs/<project>/<ticket>-<run>.jsonl`.
  Set `TICKET_HOME` to use a different folder.

## Permissions and git

Workers run headless, so nobody can answer a permission prompt. Under the default
`permission=acceptEdits` file edits are allowed and most shell commands are denied (the worker
then ends the ticket `blocked`). Local git is allowed so workers can commit on a
`ticket/<name>` branch; `git push`, `git remote` and `git config` are always denied. Tickets that
must run builds or tests need `permission=bypass`, which runs with no permission checks at all, so
use it only on projects you trust.

Workers do not inherit the session identity of the Claude Code session that started `ticket run`
(session id, tokens, sockets): they would otherwise report the parent's session id and a resume
would resume the wrong session. Set `TICKET_INHERIT_CLAUDE_ENV=1` to pass the whole environment.

## Development

```sh
bun test                 # unit + end-to-end tests (fake workers, no API calls)
bunx tsc --noEmit        # typecheck
TICKET_WORKER=fake ticket run --plain   # run the orchestrator with fake workers
```

Fake tickets are driven by their query: `FAKE:done`, `FAKE:blocked <q>`, `FAKE:failed <r>`,
`FAKE:ratelimit [session|weekly|opus] [resets 3:45pm]`, `FAKE:sleep <ms> then done`.
