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
curl -fsSL https://raw.githubusercontent.com/OliverVillson/salu/main/scripts/install.sh | bash
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
salu queue "fix login"                         # adding only saves a ticket; queue it to let it run
salu run                                       # queues everything saved, then the orchestrator with a live view
salu run --detach                              # or in the background; `salu stop` ends it
salu status                                    # state, counts, pause reason and resume time
salu log "fix login" --follow                  # worker transcript
```

## Commands

| Command | What it does |
| --- | --- |
| `salu add project "sub" --in parent` | Subproject (also `"parent/sub"`); its folder defaults to a folder inside the parent's. A project shows the tickets of all its subprojects, a subproject only its own. `salu change project "x" --in parent\|none` moves it; removing a project removes its subprojects too (it asks first). |
| `salu add project "name" [path] [--clone git-url]` | Registers a project. With no `path` it uses the current folder if that is a git repo, else creates `./<name>`. `--clone <url>` (with `--path folder`, default `./<repo name>`) has salu clone the repo there first; the folder must be new or empty. Works with `--in parent`. Flags: `--model`, `--effort`, `--concurrency`, `--default`. |
| `salu add "name" "query" ["tags"] [--queue]` | Saves a ticket (status `backlog`); it never runs by itself. `query` is the prompt the worker gets. Tags are `key=value` pairs and bare labels. `--queue` saves and queues it. |
| `salu queue "name"... \| --all [project]` | Queues saved tickets (status `todo`, shown as queued): a running orchestrator starts them at once. Also re-queues a done, failed or blocked ticket. `--now` goes to the front. |
| `salu reply "name" ["message"] [--now]` | Keep chatting on a ticket after its reply: resumes the same worker session (same `salu/` branch) with your message, and answers a blocked ticket's question too. No message prints the conversation. In the TUI: open the ticket, press `r`. |
| `salu allow "name" [--tool RULE]` | Unblocks a ticket that was refused a permission: adds the denied rule (or `--tool`) to its `tools` and queues it again. |
| `salu unqueue "name"` | Takes a queued ticket that has not started back to the backlog. |
| `salu remove "name" [--yes]` | Deletes a ticket; a running one is stopped first. `salu remove project "name"` deletes a project and its tickets. |
| `salu change "name" [--name] [--query] [--tags] [--priority] [--status]` | Edits fields. No flags opens the inline editor. `--status todo` re-queues a ticket. `salu change project "name" --path/--model/--effort/--concurrency/--default` edits a project. |
| `salu list [project] [--plain] [--status S] [--projects] [--json]` | Interactive list; `--plain` prints a table (also when piped). |
| `salu run [project\|"name"...] [--concurrency N] [--detach] [--plain]` | Queues every saved ticket (or only the named tickets, or those in the named project) and starts the orchestrator. If one is already running it just queues and lets it pick them up. |
| `salu pause` / `salu resume` / `salu stop` | Pause dispatch after current workers finish; resume early; stop a detached orchestrator. |
| `salu status [--json]` | One screen of state. |
| `salu notif [--all] [--json]` | Messages from your project orchestrators: a ticket is done, blocked on a question, failed, or paused for the usage limit. In a terminal it opens the notification window; `--plain` (or a pipe) prints them. `salu notif read <id>... \| --all` marks them read from the shell. |
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
| `tools` | `standard`, `readonly`, `edit`, `none`, or `allow:Read,Grep,Bash(git *)` with optional `;deny:Bash(rm *)` | the project's default, else `standard` |

`tools` picks what a worker may use. `standard` is Claude Code's regular toolset. `readonly` reads,
searches and browses the web, `edit` adds file edits and local git, `none` gives the worker no tools.
`allow:` lists the only tools available (a rule such as `Bash(git *)` also allows just those commands
without asking) and `deny:` removes tools. Quote a value that contains spaces:
`salu add "audit" "..." 'tools="allow:Read,Grep,Bash(git log *)"'`. Projects and subprojects can set a
default with `--tools` (inherited down the tree). `permission` still decides prompts: `bypass` checks
nothing but the `tools` restriction and any `deny:` still apply, and `plan` runs nothing.
`also:Bash(npm test *)` keeps the standard toolset and additionally lets those commands run
without asking (it can follow a preset: `edit;also:...`).

Any other token (`bug`, `docs`, `team=core`) is stored as a label or custom tag for filtering.

## Running on a box (git sync)

`salu remote add web` (on your computer) and `salu remote add web <url> --box` plus `salu remote sync --watch`
(on an always-on Linux box) run a project on the box with git as the only link: tickets you add go to the box,
`salu reply "name" "text"` keeps the conversation going, and results (`salu/<ticket>` branches) and messages come
back through the project's own git remote, on the branch `salu/inbox`. No server, no open port. Use a private
repository: anyone who can push to it can send the box tickets. Format and details: INTERFACES.md ("Git sync transport").

## The kernel (sandbox, opt-in per project)

`salu add project web --sandbox` (or `salu change project web --sandbox` / `--no-sandbox`) runs that
project's workers in a kernel:

- Each project gets its own copy of the code in `~/.salu/kernel/<project>` (override: `SALU_KERNEL`).
  A git project is cloned locally, uncommitted changes included; a plain folder is copied and given a git repo.
- Shell commands run in Claude Code's OS sandbox (Seatbelt on macOS, bubblewrap on Linux, see `salu doctor`).
  They can write only in the kernel folder, cannot read your home folder (SSH keys, git login, other projects),
  and can reach any site. `SALU_SANDBOX_DOMAINS=github.com,*.npmjs.org` limits them to a list instead.
- The agents' file tools (Read, Edit, Write, Glob, Grep), which the OS sandbox does not cover, go through a
  check on real paths (symlinks and `..` resolved, hard-linked files refused): they can change files only inside the kernel folder (and
  temp, never its `.git/hooks`, `.git/config` or `.claude`) and read only the kernel, temp, runtime folders
  and system libraries. Other projects' kernels, your real project folder and your home folder are closed.
- Agents get an allow-list environment (PATH, locale, proxy and CA settings, Claude/Anthropic variables), not
  your tokens or database URLs. `SALU_ENV_PASS=NAME,OTHER` lets chosen variables through.
- A sandbox that cannot start stops the ticket instead of running unprotected.
- Nothing reaches your real project until you run, yourself, from a terminal (a guard rail: the real barrier is that agents cannot write outside the kernel or use your git login):
  - `salu push [project] [--branch B] [--to url] [--dry-run]` pushes the `salu/*` branches to the project's git remote.
  - `salu export <folder> [project] [--git] [--force]` copies the files to a folder.

Not covered: the OS sandbox fences shell commands; the file tools are fenced by the permission rules above.
Anything an agent can read inside the kernel can be sent to any site it can reach. Linux needs
`sudo apt-get install bubblewrap socat`. `SALU_SANDBOX=off` switches it off everywhere.

## Interactive list (demo: `bun run src/tui/demo.ts`)

| Key | Action |
| --- | --- |
| ↑ / ↓, j / k | Move the cursor |
| Enter | Open the ticket (query, tags, last run, live log tail if running) |
| a / e / d | Add, edit, delete (one-key confirm) |
| r | Queue the selected ticket and run it now, ahead of the queue (a saved ticket never runs until queued) |
| a | On a ticket blocked by a permission (list, properties or output): allow what it was refused and queue it again, after a confirm line |
| p | Pause or resume the orchestrator |
| n | Notifications (also `notif` on the command line): rest the mouse on a message, or press Enter, and it is marked read and goes away |
| / | Filter by name, label or status |
| Tab / Shift-Tab | The only keys that move between windows (projects, tickets, command line) |
| → on a done, failed or blocked ticket | Its output: the result, the error, and the run transcript (↑↓ scroll, `[` `]` earlier runs, `p` properties, `o` back to output) |
| → on a ticket | Properties: every setting, changeable in place (← goes back) |
| → on tags (new ticket) | Tag groups: Model / effort, Tools (`standard` = Claude Code's regular tools), Other |
| < / > | Narrow terminals: switch project |
| q / Esc | Quit, or close the open ticket |

## Notifications (`salu notif`)

An orchestrator tells you when a ticket needs a human: done, blocked (with its question), failed for
good, or the orchestrator paused for the usage limit, or stopped because of a problem such as an
expired login. Retries and interruptions stay silent. `salu notif` shows the unread messages, newest
first; the list header and `salu status` show how many are waiting.

Messages from a box come over the project's git remote (see `salu remote`, the format is in
INTERFACES.md) and are kept on your computer; the window and `salu notif` fetch new ones (`--no-fetch`
skips that, `SALU_NO_FETCH=1` turns background fetching off). An orchestrator running on this
computer posts its messages the same way, so one window shows both.

In the window, **resting the mouse on a message for about half a second marks it read and it goes
away** (it does not repeat for the next one until the mouse moves). The keyboard does the same: ↑↓
to a message, Enter marks it read, `a` marks all read, Esc closes. A click marks read at once and the
wheel scrolls. Mouse reporting is only on while the window is open; `SALU_NO_MOUSE=1` keeps it off and
the keyboard still does everything. `salu notif --all` keeps read messages in the list, dimmed.
From the shell: `salu notif --plain` prints them (and leaves them unread), `salu notif read <id>... |
--all` marks them read, `salu notif add "title" --project P` posts one by hand.

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
`salu/<name>` branch, and read-only network git (`git clone`, `git fetch`, `git ls-remote`) is
allowed too; `git push`, `git remote` and `git config` are always denied.

When a worker is refused something else, the ticket ends `blocked` and records what it was refused:
`salu list` shows `needs permission Bash(npm test *)`. `salu allow "name"` adds exactly that rule
to the ticket (`tools=standard;also:Bash(npm test *)`) and queues it again; `--tool 'Bash(make *)'`
names a rule yourself, and `salu change project "x" --tools 'also:Bash(make *)'` allows it for a
whole project. Tickets that must run arbitrary builds or tests can instead use `permission=bypass`,
which runs with no permission checks at all, so use it only on projects you trust.

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
