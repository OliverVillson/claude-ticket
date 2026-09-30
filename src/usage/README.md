# src/usage: usage-window pause and auto-resume

Owner: the "Usage window pause/resume" thread. The orchestrator calls this module through `src/orchestrator/gate.ts`; nothing here imports the orchestrator, the TUI or the CLI.

A Claude subscription meters Claude Code in a rolling 5-hour window, a 7-day window, and per-model weekly windows (Opus, Sonnet, and others). When one is used up every request is refused until it resets. This module notices that, records a pause in the `state` table, and confirms the window is open before dispatch continues.

## Flow

1. A worker streams SDK messages. `detectLimit(msg)` returns a `LimitHit` when one of them is a usage-limit refusal.
2. The orchestrator marks the ticket `paused` (keeping its session) and calls `enterPause(db, hit)`.
3. Before each claim, `gateFor(db, model)` says whether that model may run. A pause on `opus` holds only Opus tickets.
4. Once `paused_until` (reset time + 60 s) has passed, `resumeIfDue(db, { probe })` runs one probe. Open: the pause is cleared and paused tickets resume with `resume: session_id`. Closed: the pause is pushed to the reset time the probe reports, or backed off 10, 20, 40, then 60 minutes. Inconclusive three times in a row (a closed probe resets the count): resume anyway, and a worker re-enters the pause if the window is still closed.
5. A manual pause (`salu pause`) is never cleared by a probe. `clearLimitPause` keeps it.

## Signals (verified against @anthropic-ai/claude-agent-sdk 0.3.285)

| Signal | Where | Used for |
| --- | --- | --- |
| `{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType, resetsAt } }` | SDK message stream. `resetsAt` is unix seconds. Re-emitted about every 30 s while refused. | Primary pause signal. `rateLimitType` picks session, weekly, Opus, Sonnet or another model. |
| `assistant` message with `error: 'rate_limit'` and text like `You've hit your session limit · resets 3:45pm` | SDK message stream | Fallback. Text is parsed with `parseLimitText`. |
| `result` with `is_error: true` and the same text in `result` or `errors` | SDK message stream | Fallback. |
| `system/api_retry` with `error: 'rate_limit'` | SDK message stream | Not a pause: the CLI is still retrying. Logged only (`isRateLimitRetry`). |
| `query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` | Control request `get_usage`. Gives `rate_limits.five_hour / seven_day / seven_day_opus / seven_day_sonnet / model_scoped` with `utilization` (0-100) and `resets_at` (ISO). | First probe step, no model turn. Unavailable on API-key and third-party providers; falls through to a one-turn probe. |

The limit-line prefixes are the SDK's own `USAGE_LIMIT_ERROR_PREFIXES`; a test compares our copy with the SDK export so a change upstream fails loudly.

## Not verified

- A real subscription window has not been run into. This was built in a sandbox that authenticates with an API key, where `get_usage` reports `rate_limits_available: false`. Everything above comes from the SDK's type definitions and bundled strings, the Claude Code error docs, and stubbed streams. Plan phase 3 still asks for one real run: let a queue run into the window and check it finishes after the reset.
- The reset text formats (`3:45pm`, `Mon 12:00am`, `Oct 7 12:00am`, `in 2h`) come from the docs and the CLI's formatter. `parseResetPhrase` handles all of them and returns null for anything else; a null time means "wait 10 minutes and probe".
- `get_usage` is marked experimental by the SDK. It is looked up by name pattern and any failure falls through to the turn probe.

## State keys (in the core's `state` table)

Core keys, also read by `salu status`, `salu pause/resume` and the TUI: `paused_until`, `pause_reason`, `pause_kind`, `pause_models`, `manual_pause`. Own keys: `usage_paused_since`, `usage_pause_source`, `usage_probe_attempts`, `usage_probe_unknown`, `usage_last_hit`, `usage_last_resume`.

## Knobs

- `SALU_WORKER=fake`: `probeWindow` never calls the SDK. `SALU_FAKE_LIMIT_UNTIL=<epoch ms>` or a file `fake-limit-until` in `SALU_HOME` keeps the window closed until then.
- `SALU_RESUME_MARGIN_MS`: read by the orchestrator's gate; shortens the 60 s margin in tests.

## Tests

`bun test test/usage.test.ts`: parsing, state, formatting, `/usage` interpretation, the probe against a stubbed SDK, and the wait loop. `test/orchestrator.test.ts` covers the same module inside the real dispatch loop.
