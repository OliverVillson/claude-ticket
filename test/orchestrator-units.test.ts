import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTrailer, systemAppend, ticketSlug, buildPrompt, buildResumePrompt } from '../src/orchestrator/prompt.ts';
import { betterHit, describeTool, describeToolCall, effectiveSettings, runWorker, SESSION_ENV_VARS, workerEnv, workerSdkOptions } from '../src/orchestrator/worker.ts';
import { parsePlan, plannerPrompt } from '../src/orchestrator/plan.ts';
import { renderLine, renderLog } from '../src/orchestrator/log.ts';
import { describePause, formatEvent } from '../src/orchestrator/view.ts';
import { selfCommand } from '../src/orchestrator/index.ts';
import type { Project, TicketView } from '../src/db/types.ts';
import type { LimitHit } from '../src/usage/types.ts';
import type { WorkerRunner } from '../src/orchestrator/types.ts';

function tv(over: Partial<TicketView> = {}): TicketView {
  return {
    id: 7, project_id: 1, name: 'Add login page', query: 'Build the login page.', tags: '{}', labels: '[]', priority: 3, status: 'todo', attempts: 0,
    session_id: null, cost_usd: 0, error: null, depends_on: null, created_at: 0, updated_at: 0, started_at: null, finished_at: null,
    project: 'web', project_path: '/work/web', ...over,
  };
}
const proj = (over: Partial<Project> = {}): Project => ({ id: 1, name: 'web', path: '/work/web', is_default: 1, default_model: null, default_effort: null, default_tools: null, concurrency: null, created_at: 0, parent_id: null, ...over });

describe('TICKET: trailer', () => {
  test.each([
    ['done\n\nTICKET: done', 'done', ''],
    ['x\nTICKET: blocked which db?', 'blocked', 'which db?'],
    ['x\nTICKET: failed  no network access', 'failed', 'no network access'],
    ['x\n**TICKET: done**', 'done', ''],
    ['x\n`TICKET: blocked need a key`', 'blocked', 'need a key'],
    ['x\nticket: DONE', 'done', ''],
    ['x\nTICKET: failed: cannot parse', 'failed', 'cannot parse'],
    ['TICKET: blocked first\nmore work\nTICKET: done', 'done', ''],
    ['TICKET: done\n\nAll set, thanks.', 'done', ''],
  ])('%j', (text, kind, message) => {
    expect(parseTrailer(text)).toEqual({ kind: kind as any, message });
  });
  test('no trailer', () => {
    expect(parseTrailer('I finished the work.')).toBeNull();
    expect(parseTrailer('')).toBeNull();
    expect(parseTrailer(null)).toBeNull();
    expect(parseTrailer('The TICKET: label is documented here')).toBeNull();
  });
});

describe('prompts', () => {
  test('the first prompt names the ticket and project, then carries the query', () => {
    const p = buildPrompt(tv({ labels: '["bug","ui"]' }));
    expect(p.split('\n')[0]).toBe('Ticket "Add login page" (#7) in project "web" [bug, ui]');
    expect(p).toContain('Build the login page.');
    expect(p).toContain('TICKET: trailer');
  });
  test('the resume prompt repeats the ticket text and asks to check the files first', () => {
    const p = buildResumePrompt(tv(), 'the 5-hour window ran out');
    expect(p).toContain('the 5-hour window ran out');
    expect(p).toContain('Build the login page.');
    expect(p).toMatch(/current state of the files/);
  });
  test('the system prompt carries the rules and the branch name', () => {
    const s = systemAppend(tv());
    expect(s).toContain('ticket "Add login page" of project "web"');
    expect(s).toContain('/work/web');
    expect(s).toContain('salu/add-login-page');
    expect(s).toContain('never push');
    expect(s).toContain('TICKET: blocked');
  });
  test('ticketSlug', () => {
    expect(ticketSlug('Fix: the  BIG bug (#12)!')).toBe('fix-the-big-bug-12');
    expect(ticketSlug('???')).toBe('ticket');
  });
});

describe('SDK options', () => {
  test('defaults: acceptEdits, 50 turns, project cwd, claude_code preset, no prompts', () => {
    const o = workerSdkOptions(tv(), proj());
    expect(o.cwd).toBe('/work/web');
    expect(o.maxTurns).toBe(50);
    expect(o.permissionMode).toBe('acceptEdits');
    expect(o.model).toBe('claude-opus-5-5');
    expect(o.effort).toBe('medium');
    expect(o.resume).toBeUndefined();
    expect(o.permissionPrompts).toBe('none');
    expect((o.systemPrompt as any).preset).toBe('claude_code');
    expect((o.systemPrompt as any).append).toContain('TICKET: done');
  });
  test('ticket tags beat project defaults', () => {
    const t = tv({ tags: JSON.stringify({ model: 'opus', effort: 'max', 'max-turns': '12', permission: 'plan' }) });
    const o = workerSdkOptions(t, proj({ default_model: 'sonnet', default_effort: 'low' }));
    expect(o.model).toBe('opus');
    expect(o.effort).toBe('max');
    expect(o.maxTurns).toBe(12);
    expect(o.permissionMode).toBe('plan');
  });
  test('project defaults apply when the ticket has no tags', () => {
    const s = effectiveSettings(tv(), proj({ default_model: 'sonnet', default_effort: 'high' }));
    expect(s.model).toBe('sonnet');
    expect(s.effort).toBe('high');
  });
  test('git is allowed locally but never pushed, except under bypass or plan', () => {
    const o = workerSdkOptions(tv(), proj());
    expect(o.allowedTools).toContain('Bash(git commit:*)');
    expect(o.disallowedTools).toContain('Bash(git push:*)');
    expect(workerSdkOptions(tv({ tags: JSON.stringify({ permission: 'bypass' }) }), proj()).allowedTools).toBeUndefined();
    expect(workerSdkOptions(tv({ tags: JSON.stringify({ permission: 'plan' }) }), proj()).disallowedTools).toBeUndefined();
  });
  test('bypass needs the explicit opt-in flag', () => {
    const o = workerSdkOptions(tv({ tags: JSON.stringify({ permission: 'bypass' }) }), proj());
    expect(o.permissionMode).toBe('bypassPermissions');
    expect(o.allowDangerouslySkipPermissions).toBe(true);
  });
  test('resume carries the saved session id', () => {
    expect(workerSdkOptions(tv(), proj(), { resume: 'abc-123' }).resume).toBe('abc-123');
  });
  test('an invalid max-turns falls back to 50', () => {
    expect(workerSdkOptions(tv({ tags: JSON.stringify({ 'max-turns': 'lots' }) }), proj()).maxTurns).toBe(50);
  });
  test("SALU_CLAUDE_PATH selects the claude executable", () => {
    process.env.SALU_CLAUDE_PATH = '/opt/claude';
    try {
      expect(workerSdkOptions(tv(), proj()).pathToClaudeCodeExecutable).toBe('/opt/claude');
    } finally {
      delete process.env.SALU_CLAUDE_PATH;
    }
  });
});

describe('worker environment', () => {
  test("drops the parent session's identity but keeps everything else", () => {
    const saved = { ...process.env };
    process.env.CLAUDE_CODE_SESSION_ID = 'parent-session';
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = '/tmp/x.sock';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.MY_SETTING = 'kept';
    try {
      const env = workerEnv({ TICKET_ID: '9' });
      for (const k of SESSION_ENV_VARS) expect(env[k]).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
      expect(env.MY_SETTING).toBe('kept');
      expect(env.TICKET_ID).toBe('9');
      expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toContain('salu');
      expect(process.env.CLAUDE_CODE_SESSION_ID).toBe('parent-session'); // ours is untouched
    } finally {
      for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'ANTHROPIC_API_KEY', 'MY_SETTING']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe('tool descriptions', () => {
  test('short labels', () => {
    expect(describeTool('Bash', { command: 'bun   test\n--watch' })).toBe('Bash: bun test --watch');
    expect(describeTool('Edit', { file_path: '/a/b/db.ts' })).toBe('Edit: db.ts');
    expect(describeTool('Grep', { pattern: 'foo' })).toBe('Grep: foo');
    expect(describeTool('TodoWrite', {})).toBe('planning');
    expect(describeTool('mcp__x__y', {})).toBe('mcp__x__y');
    expect(describeToolCall('Bash', { command: 'ls' })).toBe('Bash(ls)');
    expect(describeToolCall('Foo', {})).toBe('Foo');
  });
});

describe('limit precedence', () => {
  const typed: LimitHit = { kind: 'session', resetsAt: 1_800_000_000_000, models: [], source: 'rate_limit_event', raw: 'x' };
  const text: LimitHit = { kind: 'session', resetsAt: 1_799_999_000_000, models: [], source: 'error_text', raw: 'y' };
  const textNoTime: LimitHit = { ...text, resetsAt: null };
  test('the typed event wins over text, in either order', () => {
    expect(betterHit(null, text)).toBe(true);
    expect(betterHit(text, typed)).toBe(true);
    expect(betterHit(typed, text)).toBe(false);
  });
  test('a known reset time is never replaced by an unknown one', () => {
    expect(betterHit(text, textNoTime)).toBe(false);
    expect(betterHit(textNoTime, text)).toBe(true);
  });
});

describe('runWorker classification', () => {
  const stream = (msgs: any[], opts: { throwAfter?: Error } = {}): WorkerRunner => ({
    name: 'fake',
    async *run() {
      for (const m of msgs) yield m;
      if (opts.throwAfter) throw opts.throwAfter;
    },
    async probe() {
      return 'ok';
    },
  });
  const init = { type: 'system', subtype: 'init', session_id: 'S1', model: 'm' };
  const res = (extra: any) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.5, session_id: 'S1', result: '', errors: [], ...extra });
  const run = (runner: WorkerRunner, resume: string | null = null) =>
    runWorker({ ticket: tv(), project: proj(), resume, abort: new AbortController(), runner, logPath: join(tmpdir(), `nolog-${Date.now()}-${Math.random()}.jsonl`) });

  test('the SDK failing to find claude is an environment problem, not a failed ticket', async () => {
    const r = await run(stream([], { throwAfter: new Error('Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.') }));
    expect(r).toMatchObject({ outcome: 'failed', subtype: 'environment', costUsd: 0 });
    expect(r.message).toContain('claude.ai/install.sh');
    expect(r.message).not.toContain('Native CLI binary');
  });
  test('success with the done trailer', async () => {
    const r = await run(stream([init, res({ result: 'ok\nTICKET: done' })]));
    expect(r).toMatchObject({ outcome: 'done', sessionId: 'S1', costUsd: 0.5, turns: 3 });
  });
  test('success without a trailer still counts as done', async () => {
    expect((await run(stream([init, res({ result: 'All finished.' })]))).outcome).toBe('done');
  });
  test('blocked and failed trailers carry their text', async () => {
    expect(await run(stream([init, res({ result: 'TICKET: blocked which env?' })]))).toMatchObject({ outcome: 'blocked', message: 'which env?' });
    expect(await run(stream([init, res({ result: 'TICKET: failed tests are red' })]))).toMatchObject({ outcome: 'failed', message: 'tests are red' });
  });
  test('max turns is a resumable failure', async () => {
    const r = await run(stream([init, res({ subtype: 'error_max_turns', is_error: true, errors: ['x'], num_turns: 50 })]));
    expect(r).toMatchObject({ outcome: 'failed', resumable: true });
    expect(r.message).toContain('50');
  });
  test('an execution error is a failure', async () => {
    const r = await run(stream([init, res({ subtype: 'error_during_execution', is_error: true, errors: ['boom'] })]));
    expect(r).toMatchObject({ outcome: 'failed', message: 'boom', resumable: false });
  });
  test('a thrown error is a failure carrying the process stderr', async () => {
    const r = await run(stream([init, { type: 'stderr', text: 'unknown flag --frobnicate' }], { throwAfter: new Error('Claude Code process exited with code 1') }));
    expect(r.outcome).toBe('failed');
    expect(r.subtype).not.toBe('environment');
    expect(r.message).toBe('Claude Code process exited with code 1: unknown flag --frobnicate');
  });
  test('a logged-out Claude Code is an environment problem with the login fix', async () => {
    const r = await run(stream([init, { type: 'stderr', text: 'not logged in' }], { throwAfter: new Error('Claude Code process exited with code 1') }));
    expect(r).toMatchObject({ outcome: 'failed', subtype: 'environment' });
    expect(r.message).toContain('/login');
  });
  test('the typed rate limit event makes it rate_limited, keeping the session', async () => {
    const r = await run(stream([init, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_900_000_000 } }, res({ is_error: true, result: "You've hit your session limit · resets 3:45pm" })]));
    expect(r.outcome).toBe('rate_limited');
    expect(r.sessionId).toBe('S1');
    expect(r.limit).toMatchObject({ kind: 'session', source: 'rate_limit_event', resetsAt: 1_900_000_000_000 });
    expect(r.resumable).toBe(true);
  });
  test('limit text alone is enough', async () => {
    const r = await run(stream([init, res({ is_error: true, result: "You've hit your Opus limit · resets 3:45pm" })]));
    expect(r.outcome).toBe('rate_limited');
    expect(r.limit).toMatchObject({ kind: 'opus' });
  });
  test('an allowed rate_limit_event alone does not pause', async () => {
    const r = await run(stream([init, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', utilization: 0.4 } }, res({ result: 'TICKET: done' })]));
    expect(r.outcome).toBe('done');
    expect(r.limit).toBeNull();
  });
  test('a limit line inside a successful answer is not a limit', async () => {
    const r = await run(stream([init, res({ result: "The docs say \"You've hit your session limit\" appears when full.\nTICKET: done" })]));
    expect(r.outcome).toBe('done');
  });
  test('an aborted worker is killed', async () => {
    const ac = new AbortController();
    const runner: WorkerRunner = {
      name: 'fake',
      async *run() {
        yield init;
        ac.abort();
        throw new Error('aborted');
      },
      async probe() {
        return 'ok';
      },
    };
    const r = await runWorker({ ticket: tv(), project: proj(), resume: null, abort: ac, runner, logPath: join(tmpdir(), `nolog-${Math.random()}.jsonl`) });
    expect(r.outcome).toBe('killed');
    expect(r.sessionId).toBe('S1');
  });
  test('live turns count API responses, not content blocks', async () => {
    const seen: number[] = [];
    const a = (id: string, block: any) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, content: [block] } });
    await runWorker({
      ticket: tv(), project: proj(), resume: null, abort: new AbortController(), logPath: join(tmpdir(), `nolog-${Math.random()}.jsonl`),
      onLive: (l) => seen.push(l.turns),
      runner: stream([init, a('m1', { type: 'text', text: 'hi' }), a('m1', { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }), a('m2', { type: 'text', text: 'done' }), res({ result: 'TICKET: done' })]),
    });
    expect(Math.max(...seen)).toBe(2);
  });
});

describe('plan parsing', () => {
  const two = '[{"name":"a","query":"do a","tags":"effort=low","priority":2},{"name":"b","query":"do b"}]';
  test('reads a bare array', () => {
    const p = parsePlan(two);
    expect(p).toHaveLength(2);
    expect(p[0]).toEqual({ name: 'a', query: 'do a', tags: 'effort=low', priority: 2 });
    expect(p[1]).toEqual({ name: 'b', query: 'do b', tags: '', priority: 3 });
  });
  test('tolerates a code fence and prose around it', () => {
    expect(parsePlan('Here is the split:\n```json\n' + two + '\n```\nDone.')).toHaveLength(2);
  });
  test('drops entries without a name or query, and duplicates; clamps priority', () => {
    const p = parsePlan('[{"name":"a","query":"x","priority":9},{"name":"A","query":"dup"},{"name":"","query":"y"},{"name":"c","query":"z"}]');
    expect(p.map((x) => x.name)).toEqual(['a', 'c']);
    expect(p[0]!.priority).toBe(3);
  });
  test('fewer than two usable tickets is an error', () => {
    expect(() => parsePlan('[{"name":"only","query":"x"}]')).toThrow(/at least 2/);
    expect(() => parsePlan('nothing here')).toThrow(/JSON array/);
    expect(() => parsePlan('[{"name": ')).toThrow();
  });
  test('caps at 8', () => {
    const many = JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, query: `q${i}` })));
    expect(parsePlan(many)).toHaveLength(8);
  });
  test('the prompt carries the ticket', () => {
    expect(plannerPrompt(tv())).toContain('Build the login page.');
  });
});

describe('log rendering', () => {
  test('assistant text, tool calls, results', () => {
    expect(renderLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }] } })).toContain('Working on it');
    const tool = renderLine({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bun test' } }] } })!;
    expect(tool).toContain('⏺ Bash(bun test)');
    expect(renderLine({ type: 'user', message: { content: [{ type: 'tool_result', content: '3 pass\n0 fail' }] } })).toContain('3 pass');
    const done = renderLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok\nTICKET: done', num_turns: 2, total_cost_usd: 0.05, duration_ms: 4000 })!;
    expect(done).toContain('TICKET: done');
    expect(done).toContain('2 turns');
    expect(done).toContain('$0.05');
    expect(renderLine({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached max turns'], num_turns: 50, total_cost_usd: 1, duration_ms: 1 })).toContain('error_max_turns');
  });
  test('skips noise and subagent chatter', () => {
    expect(renderLine({ type: 'stream_event' })).toBeNull();
    expect(renderLine({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'text', text: 'sub' }] } })).toBeNull();
    expect(renderLine({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).toBeNull();
    expect(renderLine(null)).toBeNull();
  });
  test('only a rejected limit event is shown', () => {
    expect(renderLine({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_900_000_000 } })).toContain('usage limit');
  });

  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'ticket-log-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const capture = () => {
    let buf = '';
    return { out: { write: (s: string) => ((buf += s), true) } as any, text: () => buf };
  };
  test('renderLog prints a file and --raw prints the JSON lines', async () => {
    const f = join(dir, 'r.jsonl');
    const lines = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'hello there' }] } }, { type: 'result', subtype: 'success', is_error: false, result: 'TICKET: done', num_turns: 1, total_cost_usd: 0.01, duration_ms: 10 }];
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const a = capture();
    await renderLog(f, { out: a.out });
    expect(a.text()).toContain('hello there');
    expect(a.text()).toContain('TICKET: done');
    const b = capture();
    await renderLog(f, { out: b.out, raw: true });
    expect(b.text().trim().split('\n').map((l) => JSON.parse(l).type)).toEqual(['assistant', 'result']);
  });
  test('following stops at the result line', async () => {
    const f = join(dir, 'f.jsonl');
    writeFileSync(f, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }) + '\n');
    const c = capture();
    const done = renderLog(f, { out: c.out, follow: true, pollMs: 20, keepFollowing: () => true });
    await new Promise((r) => setTimeout(r, 80));
    const { appendFileSync } = await import('node:fs');
    appendFileSync(f, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } }) + '\n');
    await new Promise((r) => setTimeout(r, 60));
    appendFileSync(f, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'TICKET: done', num_turns: 1, total_cost_usd: 0, duration_ms: 1 }) + '\n');
    await done;
    expect(c.text()).toContain('first');
    expect(c.text()).toContain('second');
    expect(c.text()).toContain('TICKET: done');
  });
  test('a missing file without --follow says so', async () => {
    const c = capture();
    await renderLog(join(dir, 'nope.jsonl'), { out: c.out });
    expect(c.text()).toContain('no log written yet');
  });
});

describe('event lines', () => {
  const t = tv();
  test('each event has a readable line', () => {
    expect(formatEvent({ type: 'dispatch', ticket: t, runId: 3, resumed: true })).toContain('resuming session');
    expect(formatEvent({ type: 'finish', ticket: t, outcome: 'done', costUsd: 0.1, turns: 2, durationMs: 5000 })).toContain('done');
    expect(formatEvent({ type: 'finish', ticket: t, outcome: 'failed', costUsd: 0, turns: 1, error: 'bad', status: 'todo' })).toContain('will retry');
    expect(formatEvent({ type: 'finish', ticket: t, outcome: 'failed', costUsd: 0, turns: 1, error: 'bad', status: 'failed' })).not.toContain('will retry');
    expect(formatEvent({ type: 'finish', ticket: t, outcome: 'blocked', costUsd: 0, turns: 1, error: 'which db?' })).toContain('which db?');
    expect(formatEvent({ type: 'worker', ticket: t, turns: 1, lastTool: null })).toBeNull();
    expect(formatEvent({ type: 'idle' })).toContain('queue empty');
  });
  test('pause text: manual, session countdown, weekly, per-model', () => {
    const now = 1_000_000;
    expect(describePause({ until: null, reason: 'x', kind: 'manual', models: [], manual: true }, now)).toContain('salu resume');
    const s = describePause({ until: now + 3_600_000, reason: 'x', kind: 'session', models: [] }, now);
    expect(s).toContain('resumes');
    expect(s).toContain('1h');
    expect(describePause({ until: now + 3 * 86_400_000, reason: 'x', kind: 'weekly', models: [] }, now)).toContain('days');
    expect(describePause({ until: now + 1000, reason: 'x', kind: 'opus', models: ['opus'] }, now)).toContain('opus tickets');
    expect(describePause({ until: now - 1, reason: 'x', kind: 'session', models: [] }, now)).toContain('checking');
  });
});

describe('detach command line', () => {
  test('re-runs the same script with bun', () => {
    const cmd = selfCommand(['run', '--plain']);
    expect(cmd.slice(-2)).toEqual(['run', '--plain']);
    expect(cmd[0]).toBe(process.execPath);
  });
});
