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
- Ticket statuses: `todo | running | done | failed | blocked | paused`. Priority 1..5 (1 highest, default 3).
  **Priority 0 means "run now"** (set by the TUI's `r` key); never offered in the CLI parser, displayed as `now`.
- `ticketTags(t)` / `ticketLabels(t)` parse the JSON columns. Tag keys the orchestrator reads:
  `model`, `effort`, `max-turns`, `permission` (`plan|default|acceptEdits|bypass|dontAsk`). Project defaults:
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
