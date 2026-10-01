# Interfaces and module contract for the ticket CLI


Code location: shared folder `/mnt/project-files/claude-ticket` (sources only; run `bun install` in a local copy, the shared folder is a FUSE mount where `node_modules` must not live). The build thread ("Build the ticket CLI") owns the core (`src/db`, `src/core`, `src/cli`, `src/index.ts`) and final integration. Module owners: `src/orchestrator/` = the "Orchestrator agent" thread, `src/core/ratelimit.ts` + the pause/probe/resume logic inside the orchestrator loop = the "Usage window pause/resume" thread, `src/tui/` = the "Ticket list view" thread. A first cut of all three modules, built inside the build thread against this contract, lands in the shared folder shortly after this file; build on it rather than starting over. Send integration notes through the coordinator.
Everything below is already implemented unless marked TODO. Read `src/db/queries.ts`,
`src/db/types.ts`, `src/orchestrator/status.ts`, `src/core/*.ts` and `src/cli/commands/*.ts`
before writing code. Runtime is Bun (`/root/.bun/bin/bun`), TypeScript, `bun:sqlite`.
Tests run with `bun test`; typecheck with `bunx tsc --noEmit`. Set `SALU_HOME` to an
isolated folder in every test (never touch `~/.salu`).

## Data access (done)
- `openDb()` → `bun:sqlite` Database, WAL, cached per process. Queries in `src/db/queries.ts`:
  projects (`createProject`, `getProjectByName/ById`, `listProjects`, `findProjectForCwd`, …),
  tickets (`createTicket`, `getTicketById`, `getTicket(projectId,name)`, `listTickets({projectId,status})`,
  `updateTicket(id, patch)`, `deleteTicket`, `countTickets`, `claimNextTicket({projectIds, excludeModels})`,
  `effectiveModel`), runs (`createRun`, `finishRun`, `listRuns`, `latestRun`), state (`getState`, `setState`, `getAllState`).
- Every write that matters to the orchestrator calls `wakeOrchestrator()` (touches `wakeFile()`).
- Ticket statuses: `backlog | todo | running | done | failed | blocked | paused`. `backlog` = saved, never runs by itself (`createTicket` default; pass `status: 'todo'` to queue on creation); `todo` = queued, the only status (besides `paused`) the orchestrator claims. `queueTicket` / `unqueueTicket` / `queueAll` move between them; `salu queue`, `salu unqueue`, and `salu run` (queues all saved, or the named tickets/project) are the CLI. Priority 1..5 (1 highest, default 3).
  **Priority 0 means "run now"** (set by the TUI's `r` key); never offered in the CLI parser, displayed as `now`.
- `ticketTags(t)` / `ticketLabels(t)` parse the JSON columns. Tag keys the orchestrator reads:
  `model`, `effort`, `max-turns`, `permission` (`plan|default|acceptEdits|bypass|dontAsk`), `tools` (see `src/core/tools.ts`: presets `standard|readonly|edit|none`, or `allow:A,B(x *);deny:C`; project column `default_tools`, schema v3). Project defaults:
  `project.default_model`, `project.default_effort`, `project.concurrency`.
- Orchestrator state (`src/orchestrator/status.ts`): `readStatus(db)` → `{alive, pid, heartbeat, startedAt, paused, workers, concurrency}`;
  `setPause / clearPause`; `writeWorkerInfo / clearWorkerInfo / clearAllWorkerInfo` (live per-worker rows under `worker:<ticketId>`).
  `HEARTBEAT_MS = 5000`, `STALE_MS = 20000`.
- Rate limits (`src/core/ratelimit.ts`): `parseLimitText(text)`, `limitFromSdkInfo(info)`, `pausedUntilFor(hit)`, `labelForKind`.
- Paths (`src/core/paths.ts`): `ticketHome()`, `logsDir()`, `wakeFile()`, `orchestratorLogPath()`.
- Formatting (`src/core/format.ts`, `src/core/ansi.ts`): `statusColor`, `statusIcon`, `formatDuration`, `formatClock`, `formatCost`, `table`.

## Orchestrator (TODO — owner: orchestrator agent) — `src/orchestrator/`
`index.ts` exports:
```ts
export interface OrchestratorOptions { projectIds?: number[]; concurrency?: number; signal?: AbortSignal;
  onEvent?: (e: OrchestratorEvent) => void }
export type OrchestratorEvent =
  | { type: 'start'; pid: number; concurrency: number }
  | { type: 'dispatch'; ticket: TicketView; runId: number; resumed: boolean }
  | { type: 'worker'; ticket: TicketView; turns: number; lastTool: string | null; text?: string }
  | { type: 'finish'; ticket: TicketView; outcome: RunOutcome; costUsd: number; turns: number; error?: string }
  | { type: 'pause'; until: number | null; reason: string; kind: string; models: string[] }
  | { type: 'resume' } | { type: 'probe'; ok: boolean; detail?: string }
  | { type: 'idle' } | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string } | { type: 'stop' };
export function runOrchestrator(opts: OrchestratorOptions): Promise<void>;
/** Used by `salu run`. detach → spawn a background `salu run --plain` writing to orchestratorLogPath(), print the pid, return.
 *  plain → print one line per event. Otherwise import('../tui/index.tsx').openRunView({...}) and run the loop alongside it. */
export function startOrchestratorCommand(o: { projectIds?: number[]; concurrency?: number; detach: boolean; plain: boolean }): Promise<number>;
```
Behaviour (from the plan):
- One orchestrator per machine: refuse to start if `readStatus().alive` (message names the pid). Write `STATE.pid`, `STATE.startedAt`, heartbeat every 5 s. On start, recover: tickets left `running` with no live orchestrator go back to `todo` (keep `session_id`); `clearAllWorkerInfo()`.
- Loop: wake on worker exit, `fs.watch` of `ticketHome()` for the `wake` file, or the 5 s heartbeat. Global cap: option > `STATE.concurrency` > 2. A project's `concurrency` column caps that project's running tickets. Claim with `claimNextTicket({projectIds, excludeModels})` while slots are free. Manual pause (`paused.manual`) or a rate-limit pause (`paused.until > now`, unless `paused.models` is non-empty, then only those models are excluded) stops dispatch; running workers finish.
- Each tick, re-read every active worker's ticket row: missing, or status not `running` → abort that worker (this is how `remove` and `change --status todo` stop a running ticket).
- Worker (`worker.ts`): an interface `WorkerRunner { run(input): AsyncIterable<WorkerMessage>; probe(model): Promise<'ok' | LimitHit> }` with two implementations: `sdkRunner` using `query()` from `@anthropic-ai/claude-agent-sdk` (options per plan: `prompt` = ticket query prefixed by one line naming ticket and project; `cwd` = project path; `model`/`effort` from tags then project defaults; `permissionMode` from the `permission` tag, default `acceptEdits`, `bypass` → `bypassPermissions` + `allowDangerouslySkipPermissions: true`; `maxTurns` default 50; `systemPrompt: { type: 'preset', preset: 'claude_code', append: RULES }`; `resume: session_id` when set; `abortController`), and `fakeRunner` selected by `SALU_WORKER=fake`, driven by the ticket query text (`FAKE:done [text]`, `FAKE:blocked <question>`, `FAKE:failed <reason>`, `FAKE:max-turns`, `FAKE:ratelimit [session|weekly|opus] [resets 3:45pm]`, `FAKE:sleep <ms> then <one of the above>`, `FAKE:crash`) emitting the same message shapes (`system/init` with a session_id, `assistant` with tool_use blocks, `rate_limit_event`, `result`). Every message is appended as one JSON line to `logsDir()/<project>/<ticketId>-<runId>.jsonl` as it arrives. Env `SALU_CLAUDE_PATH` → `pathToClaudeCodeExecutable`.
- RULES appended to the worker system prompt: it is working on ticket "<name>" of project "<project>"; work only inside the project folder; if the work changes files in a git repo, commit on a branch named `salu/<slug>` and never push; when finished, end the final message with exactly one line `TICKET: done`, `TICKET: blocked <question>` or `TICKET: failed <reason>`.
- Result handling: parse the trailer from the result text (`/^TICKET:\s*(done|blocked|failed)\b\s*(.*)$/m`, last match). `done`/no trailer + `subtype: success` → status `done`; `blocked` → `blocked` with `error` = the question; `failed`, `error_max_turns`, `error_during_execution`, thrown errors → `todo` again if `attempts < 2`, else `failed` with `error`. Store `session_id` (from `system/init`), `cost_usd` (`total_cost_usd`), turns (`num_turns`) on the ticket and the run (`finishRun`). Keep `writeWorkerInfo` fresh (turns, lastTool = last tool_use name, lastText = last assistant text, model).
- Rate limit: `rate_limit_event` with `status: 'rejected'` (`limitFromSdkInfo`) or a result / thrown error whose text matches `parseLimitText` → outcome `rate_limited`: ticket → `paused` (keeps `session_id`, attempts not counted), `setPause({until: pausedUntilFor(hit), reason, kind, models})`, no new dispatch for the affected models; other running workers are left alone. At `until`: `probe()` (SDK: `query` with `maxTurns: 1`, model `haiku`, prompt "Reply with the single word OK", `cwd` = os.tmpdir(), `permissionMode: 'plan'`); ok → `clearPause()`, paused tickets are claimed first (already how `claimNextTicket` orders); limit again → push `until` by 10 minutes and retry. A manual pause is never cleared by the probe.
- SIGINT/SIGTERM/abort: abort every worker, set their tickets `running → todo` (keep `session_id`), `finishRun(outcome: 'killed')`, clear pid/heartbeat/worker info, emit `stop`.
- `log.ts`: `renderLog(path, {follow, raw, ticket, run})` renders the jsonl transcript like Claude Code's `-p` output (assistant text, `⏺ ToolName(args…)` lines dimmed, result line with cost/turns); `follow` tails while the file grows and the ticket is `running`.
- `plan.ts`: `planTicket(ticket, {yes})` asks Claude (SDK query, `permissionMode: 'plan'`, `maxTurns: 3`, cwd = project path) for a JSON array `[{name, query, tags, priority}]` of 2–8 sub-tickets, prints them, confirms (unless `--yes` or `SALU_WORKER=fake`, where it returns a canned split), creates them with `createTicket`, marks the original `done`.
- Tests (`test/orchestrator.test.ts`, run with `SALU_WORKER=fake`): a queue of three tickets with concurrency 2 runs to completion; retries then `failed` after two attempts; `blocked`; a rate-limit hit pauses, the ticket is `paused` with its session id, the probe (fake: `SALU_FAKE_LIMIT_UNTIL=<epoch ms>` env or a file in `SALU_HOME`) clears it and the ticket resumes with `resume: session_id`; opus-only limit keeps sonnet tickets running; SIGTERM handling puts running tickets back to `todo`.

## TUI (TODO — owner: TUI agent) — `src/tui/index.tsx` (Ink 7, React 19, `ink-text-input`)
```ts
export function openList(o: { projectId?: number; statuses?: TicketStatus[] }): Promise<void>;
export function openTicketForm(o: { ticketId?: number; projectId?: number }): Promise<void>;
export function openRunView(o: { projectIds?: number[]; concurrency: number; stop: () => void;
  subscribe: (fn: (e: OrchestratorEvent) => void) => () => void }): Promise<void>;
```
- Look: Claude Code's language — rounded single-line border (`borderStyle="round"`), grey palette, one accent (`#D97757`) for the cursor row and running tickets, a dim status/help line at the bottom, **no alternate screen** (scrollback intact). Visible rows are windowed to the terminal height so 500 tickets stay smooth; the list re-reads the DB once per second (and after every key action) rather than holding its own copy.
- Keys: ↑/↓ or j/k move; Enter opens the ticket (full query, tags, last run summary, live tail of the log if running — read the jsonl at `latestRun(db, id).log_path`); `a` add (inline form: name, query, tags, priority), `e` edit the selected one in the same form, `d` delete with a one-key confirm, `r` run now (`updateTicket(id, {status:'todo', priority: 0})` for non-running tickets; if the orchestrator is not alive show a hint "salu run"), `p` pause/resume (`setPause({until:null, reason:'paused by salu list', kind:'manual', manual:true})` / `clearPause`, then `wakeOrchestrator()`), `/` filter by name, label or status as you type, Tab switch project (all → each project), `q`/Esc quit or close the open ticket.
- Header shows the project, counts by status, orchestrator state (from `readStatus`) and the pause reason with a countdown when paused. Priority 0 renders as `now`.
- Run view: same frame; one row per active worker (from `readStatus().workers`): name, elapsed, turns, last tool call; below it the next few queued tickets; polls twice a second; header shows paused reason + countdown; `q` calls `stop()`; `p` pauses/resumes. Events from `subscribe` append to a short scrolling activity log (last ~8 lines).
- `salu change "name"` with no flags calls `openTicketForm({ticketId})`; `salu list` calls `openList`.
- Keep imports of Ink out of every module except `src/tui/*` (startup speed). Provide a smoke test with `ink-testing-library` (add as devDependency) that renders the list with a few tickets and checks the names appear.

## Subprojects (core)

Projects form a tree: `projects.parent_id` (NULL = top level; schema version 2 migrates old databases with every project top level; deleting a project deletes its subtree). Project names stay globally unique; `a/b/c` path forms resolve through `resolveProjectRef`. A project's tickets view includes every descendant; a subproject shows only its own subtree.

`src/db/queries.ts`
- `createProject(db, { name, path, parentId?, isDefault?, defaultModel?, defaultEffort?, concurrency? }): Project`
- `listProjectTree(db): ProjectNode[]` (roots; `ProjectNode = Project & { depth, children, counts /* subtree */, own }`)
- `flattenProjectTree(nodes, isExpanded?): ProjectNode[]` (DFS rows; collapsed nodes hide their children)
- `subtreeIds(db, id): number[]`, `getChildren(db, parentId | null): Project[]`, `projectQualifiedName(db, id): string`
- `listTickets(db, { projectId?, recursive? = true, status? })`, `countTickets(db, projectId?, recursive = true)`
- `moveProject(db, id, parentId | null)` (refuses cycles; folders are not moved), `deleteProject(db, id)` (subtree + tickets)
- `inheritedProject(db, project): Project` fills model, effort and concurrency from the nearest ancestor; the orchestrator and the planner use it, rows stay as set.

`src/core/resolve.ts`
- `resolveProjectRef(db, "name" | "parent/sub"): Project`
- `newSubproject(db, parentId, name, path?, extra?): Project` (folder defaults to `<parent folder>/<slug(name)>`, created)
- `ensureProjectChain(db, ["a", "b", "c"], cwd?): Project` (creates missing projects and folders)

CLI: `salu add project "sub" --in parent` or `salu add project "parent/sub"`; `salu change project "x" --in parent|none`; `salu remove project "p"` asks first and names the tickets and subprojects it deletes (folders on disk are never touched); `salu run <project>` runs the whole subtree; `salu list --projects` shows the tree.

## Follow-ups (multi-prompt tickets)

`turns` table (schema v8): `id, ticket_id, role 'user'|'assistant', body, delivered 0|1, created_at`. The ticket's first prompt stays in `tickets.query`; everything after it is a turn. The scheduler stores the worker's final message (trailer line removed) as an `assistant` turn when a run ends `done` or `blocked`.

`src/db/queries.ts`
- `replyToTicket(db, ticketId, message, { now? }): TicketView` adds an undelivered `user` turn. A done, blocked or failed ticket is queued again; a running ticket keeps running and is queued again when it ends; a backlog ticket is refused.
- `listTurns(db, ticketId)`, `pendingFollowUps(db, ticketId)`, `addTurn(...)`, `markFollowUpsDelivered(...)`.

Scheduler: on dispatch, pending follow-ups go to the worker as `WorkerInput.followUp` (marked delivered). With a saved `session_id` the session is resumed with `buildFollowUpPrompt`; without one (a failed run started clean) `WorkerInput.history` is replayed in `buildFollowUpFreshPrompt`. `WorkerResult.text` carries the final message.

CLI `salu reply "name" ["message"] [--now]`; TUI `r` in the detail view of a done, blocked or failed ticket (`TuiActions.reply`).

## Git sync transport (`src/sync/`)

Runs a project on another computer (an always-on Linux box) with git as the only link: no server, no open port. Owner: the git sync thread. `salu notif` reads the messages described here; the remote runner hosts `salu remote sync --watch`; other box code posts through `enqueueMessage`.

**Roles.** `salu remote add <project> [git-url] [--box]` stores a row in `remotes`. `client` (default, your computer or phone): tickets you add to that project are sent to the box and never run locally. `box`: this machine accepts the tickets and runs them. `git-url` defaults to the project's `origin`.

**Branch `salu/inbox`** on that remote is an orphan branch. Files are written once, never edited or deleted, each with a unique name, so two machines pushing at once never conflict (a rejected push is fetched and retried). Each side keeps a working copy in `~/.salu/sync/<project>` (`SALU_SYNC_DIR` overrides).

```
salu-inbox/tickets/<id>.json    client -> box   a new ticket
salu-inbox/replies/<id>.json    client -> box   a follow-up on a ticket (salu reply)
salu-inbox/messages/<id>.json   box -> client   what the orchestrator tells you
```

`<id>` is `<13-digit epoch ms>-<8 hex>` (`newId()`, strictly increasing in a process, so file names sort by time). All JSON has `"v": 1`; files over 64 KB and unknown versions or types are ignored.

Ticket file: `{ v, id, project, name, query, tags{}, labels[], priority 1..5, queue (bool), at }`. On the box the tags `permission`, `tools`, `project`, `max-turns`, `model` and `effort` are dropped: a ticket from the remote may not widen what the worker may do or burn quota. The box's owner can allow some with `SALU_REMOTE_ALLOW_TAGS=model,effort,max-turns` (never permission, tools or project). A name that already exists gets ` (2)`.

Reply file (`ReplyFile`; a follow-up prompt on a ticket that already has an answer; the phone can write these too):
```
{ v:1, id, project, ticket: { ref?, id?, name? }, body, now?, at }
```
The ticket is named like `ticket` in messages: `ref` (the `id` of the ticket file it was sent with, preferred), else `id` (its number on the box), else `name`. At least one is required. The flat form `{ ref?, name?, ... }` is accepted too. The box applies a reply once (by its `id`) with `replyToTicket(db, ticketId, body, { now })` from `src/db/queries.ts`: a done, blocked or failed ticket is queued again and resumes its Claude session; a running ticket takes it as the next turn; a backlog ticket is refused. The box always answers with a message: `ticket.accepted` ("Got your reply on ...") or a `note` with level `warn` when the ticket is not found or the reply was refused. Client helper: `publishReply(db, project, ticket, body, { now })` (used by `salu reply`), or just write the file.

Message file (`MessageFile` in `src/sync/format.ts`):
```
{ v:1, id, project, from /* box name, SALU_BOX_NAME or hostname */, at /* epoch ms */,
  type: 'ticket.accepted' | 'ticket.started' | 'ticket.done' | 'ticket.blocked' | 'ticket.failed'
      | 'orchestrator.paused' | 'orchestrator.resumed' | 'note',
  level: 'info' | 'success' | 'warn' | 'error',
  title,                       // one line, what `salu notif` shows
  body?,                       // detail: the error
  ticket?: { ref?, name, id }, // ref = id of the ticket file that started it; id = ticket number on the box
  branch?,                     // salu/<ticket>, when there is a result branch
  question?,                   // ticket.blocked: what the ticket needs
  reply?,                      // done/blocked/failed: the worker's whole final reply (up to 16000 chars): what a follow-up answers
  until? }                     // orchestrator.paused: epoch ms it resumes
```

**Results.** On the box each sync also pushes every `salu/*` branch (except `salu/inbox`) of the project's repo (its kernel when the project is sandboxed) to the remote. On the client each sync fetches them into the project's repo as `salu-box/*` remote-tracking branches. On the client the `reply` of each done/blocked/failed message is stored as the ticket's latest `assistant` turn (see "Follow-ups").

**Untrusted input.** Anyone who can push to the remote can write files on `salu/inbox`, so: control characters (ESC, BEL, C1, bidi overrides; newline and tab stay) are stripped from every string at parse time, so a message cannot carry terminal escapes such as OSC 52; files over 64 KB, non-regular files and symlinks are skipped, and git runs with `core.symlinks=false` and every write is checked to stay inside the sync folder (a symlinked inbox folder makes sync stop with an error instead of writing through it). **Signing (required):** every file carries `sig` (HMAC-SHA256 of its canonical JSON without `sig`: keys sorted, compact, hex), made with one shared secret, and files without a valid one are ignored, so a pusher cannot forge tickets, replies or messages. Sync refuses to run without a key. The key is `SALU_REMOTE_KEY`, else the file `~/.salu/remote.key` (0600). `salu remote add <project> --box` makes one when there is none and shows it; `salu remote add <project> --key <secret>` / `salu remote key [--set <secret>] [--new]` give it to your computer; the phone app asks for it at setup (share it out of band, never through git). `SALU_REMOTE_ALLOW_UNSIGNED=1` is the explicit opt-out (sync runs and the red warning stays in `salu remote add`/`sync`/`doctor`). **Rotating the key:** `salu remote key --new` (or `--set <secret>`) on the box first re-signs every file already on its inboxes with the new key, in one commit per project, then saves the key. A file is re-signed only if it was valid under the old key (a forged file is left alone and stays ignored), so clients and the phone that switch to the new key still see the whole history; until they switch, what they send is ignored. If any inbox cannot be reached nothing changes and the command prints how to retry. On a machine that is not a box it only saves the key. Anything writing these files (the phone app) must sign the same way. Write-once is a convention, not a guarantee: a force-push can rewrite the branch.

**Local tables** (schema version 7; version 6 is the `turns` table of the follow-ups work): `remotes`, `remote_tickets`, `remote_replies`, `remote_messages` (id, body JSON, direction in|out, `posted` for out, `read_at` for in), all in `src/sync/store.ts`.

For `salu notif` (client side):
- `listNotifications(db, { all?, projectId?, limit? }): Notification[]` (oldest first; unread only unless `all`; `Notification = MessageFile & { projectId, read_at }`)
- `unreadCount(db)`, `markRead(db, ids[] | 'all'): number`
- `syncAll(db, projectIds?)` fetches new messages first (`salu notif` should call it; errors are returned per project, not thrown).

For anything on the box that wants to tell the user something: `enqueueMessage(db, projectId, projectName, boxName(), { type, level, title, body?, ticket?, branch?, question?, reply?, until? })` writes to the local outbox; the sync loop sends it. The orchestrator's `environment` event (it stopped because the login is dead or a tool is missing) becomes a `note` with level `error`, title "The box stopped: <reason>" and a body with the reason and the hint `salu runner restart <project>`. Its `dispatch`/`finish`/`pause`/`resume` events already become messages through `recordRemoteEvent` (`src/sync/events.ts`, called from `Orchestrator.emit`).

CLI: `salu remote add|list|remove|sync [--watch] [--interval s]`; `salu add ... [--backlog]` in a client project (sent, queued on the box unless `--backlog`); `salu reply "name" "text"` on a sent ticket goes to the box. Known limit: `salu queue`/`salu change` on the client copy of a sent ticket do not reach the box.
