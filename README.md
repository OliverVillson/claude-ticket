# salu


A fast ticket queue for Claude Code agents. You register projects, add tickets to them,
and run an orchestrator that hands each ticket to its own Claude Code session until the
queue is empty. When the subscription's 5-hour window runs out, the orchestrator pauses
and resumes on its own once the window resets.

Everything runs on top of Claude Code: workers are Claude Code sessions started through
the Agent SDK. Nothing else needs to be installed.

## Install

One command on macOS or Linux (x64 or arm64). It needs nothing else, not even Bun: it downloads a
single prebuilt binary, checks its SHA-256, puts `salu` in `~/.local/bin`, adds that folder to your
shell's PATH if it is missing, and tells you how to start.

```sh
curl -fsSL https://raw.githubusercontent.com/OliverVillson/claude-ticket/main/scripts/install.sh | bash
```

Workers run through a logged-in Claude Code (`claude auth status`).

| | |
|---|---|
| Update | `salu update` (`--check` only looks, `salu update v0.2.0` pins); re-running the install command works too |
| Pin a version | `... \| bash -s -- v0.2.0` |
| Uninstall | `... \| bash -s -- --uninstall` (add `--purge` to also delete `~/.salu`) |
| Other folder | `SALU_INSTALL_DIR=/usr/local/bin` before `bash` |
| Private repo | the anonymous download is blocked; make the repo public, or `gh auth login` (or set `GITHUB_TOKEN`) and the installer downloads through `gh` |

### Releasing (maintainers)

Binaries come from `.github/workflows/release.yml`. Push a tag and it runs the tests, cross-compiles
`salu-{darwin,linux}-{arm64,x64}` with `bun build --compile`, and attaches them and their `.sha256`
files to a GitHub release:

```sh
git tag v0.1.0 && git push --tags
```

### From source

Requires [Bun](https://bun.sh) 1.3+.

```sh
bun install
bun run install-cli   # launcher that runs this checkout; `bun run uninstall-cli` removes it
```

`install-cli` accepts `--binary` (compile `dist/salu` and install that), `--dir <folder>` and `--force`.

salu runs your installed Claude Code (install it with `curl -fsSL https://claude.ai/install.sh | bash`, then run `claude` once to log in). It finds `claude` on your PATH and in the usual install folders; `SALU_CLAUDE_PATH=/path/to/claude` overrides that. `salu doctor` checks all of this, and `salu run` checks it before starting, so a missing or logged-out Claude Code never turns into failed tickets: the ticket goes back to todo with the reason on it.

## Quick start

```sh
salu add project "myapp" ~/code/myapp          # first project becomes the default
salu add "landing page"          # no project yet? salu makes "landing-page-proj" in ./landing-page-proj
salu add "fix login" "Fix the login bug in auth.ts and add a test" "model=opus effort=high priority=1 bug"
salu add "write docs" "Write a README for the API" "docs max-turns=20"
salu list                                      # interactive list (arrow keys)
salu run                                       # orchestrator with a live view
salu run --detach                              # or in the background; `salu stop` ends it
salu status                                    # state, counts, pause reason and resume time
salu log "fix login" --follow                  # worker transcript
```

## Commands

| Command | What it does |
| --- | --- |
| `salu add project "sub" --in parent` | Subproject (also `"parent/sub"`); its folder defaults to a folder inside the parent's. A project shows the tickets of all its subprojects, a subproject only its own. `salu change project "x" --in parent\|none` moves it; removing a project removes its subprojects too (it asks first). |
| `salu add project "name" [path]` | Registers a project. With no `path` it uses the current folder if that is a git repo, else creates `./<name>`. Flags: `--model`, `--effort`, `--concurrency`, `--default`. |
| `salu add "name" "query" ["tags"]` | Adds a ticket. `query` is the prompt the worker gets. Tags are `key=value` pairs and bare labels. |
| `salu remove "name" [--yes]` | Deletes a ticket; a running one is stopped first. `salu remove project "name"` deletes a project and its tickets. |
| `salu change "name" [--name] [--query] [--tags] [--priority] [--status]` | Edits fields. No flags opens the inline editor. `--status todo` re-queues a ticket. `salu change project "name" --path/--model/--effort/--concurrency/--default` edits a project. |
| `salu list [project] [--plain] [--status S] [--projects] [--json]` | Interactive list; `--plain` prints a table (also when piped). |
| `salu run [project] [--concurrency N] [--detach] [--plain]` | Starts the orchestrator. Defaults to every project. |
| `salu pause` / `salu resume` / `salu stop` | Pause dispatch after current workers finish; resume early; stop a detached orchestrator. |
| `salu status [--json]` | One screen of state. |
| `salu log "name" [--follow] [--raw] [--run N]` | Worker transcript for a ticket. |
| `salu plan "name" [--yes]` | Asks Claude to split a ticket into sub-tickets and adds them on approval. |

Ticket names are unique within a project. When a name exists in several projects, pass
`project=<name>`, `--project`, or `--id <n>`.

### Tags

| Key | Values | Default |
| --- | --- | --- |
| `project` | a registered project | the project whose folder contains the current directory, else the default |
| `model` | `opus`, `sonnet`, `haiku`, or a full model id | the project's default, else `claude-opus-5-5` |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` | the project's default, else `medium` |
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
  branch named `salu/<name>` and never push, and to end with one line
  `TICKET: done`, `TICKET: blocked <question>` or `TICKET: failed <reason>`.
- A failed run is retried once, then the ticket is `failed`. A worker that needs a human
  answer leaves the ticket `blocked` with the question in `salu list` / `salu status`.
- Rate limit: when Claude Code reports the 5-hour, weekly or Opus limit, the ticket goes to
  `paused` with its session id, dispatch stops (for Opus-only limits, only Opus tickets),
  and the orchestrator sleeps until a minute after the reset time. It then probes with a
  one-turn Haiku call and, once the window is open, resumes the paused sessions with
  `--resume` so no work is lost. An unparseable reset time means a retry every 10 minutes.
- The CLI and the orchestrator only talk through the SQLite database at
  `~/.salu/tickets.db` (WAL mode). Worker transcripts are `~/.salu/logs/<project>/<ticket>-<run>.jsonl`.
  Set `SALU_HOME` to use a different folder.

## Permissions and git

Workers run headless, so nobody can answer a permission prompt. Under the default
`permission=acceptEdits` file edits are allowed and most shell commands are denied (the worker
then ends the ticket `blocked`). Local git is allowed so workers can commit on a
`salu/<name>` branch; `git push`, `git remote` and `git config` are always denied. Tickets that
must run builds or tests need `permission=bypass`, which runs with no permission checks at all, so
use it only on projects you trust.

Workers use your Claude login unless `ANTHROPIC_API_KEY` is set: Claude Code prefers the key, so runs would bill API credits. `salu run` warns when it sees one; `SALU_AUTH=subscription` removes the key for the run, `SALU_AUTH=api-key` keeps it and silences the warning.

Workers do not inherit the session identity of the Claude Code session that started `salu run`
(session id, tokens, sockets): they would otherwise report the parent's session id and a resume
would resume the wrong session. Set `SALU_INHERIT_CLAUDE_ENV=1` to pass the whole environment.

## Development

```sh
bun test                 # unit + end-to-end tests (fake workers, no API calls)
bunx tsc --noEmit        # typecheck
SALU_WORKER=fake salu run --plain   # run the orchestrator with fake workers
```

Fake tickets are driven by their query: `FAKE:done`, `FAKE:blocked <q>`, `FAKE:failed <r>`,
`FAKE:ratelimit [session|weekly|opus] [resets 3:45pm]`, `FAKE:sleep <ms> then done`.
