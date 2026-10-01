/**
 * A worker runner that spawns nothing. Selected with `SALU_WORKER=fake`; the ticket's query
 * text says what happens:
 *
 *   FAKE:done [text]                        success, `TICKET: done`
 *   FAKE:blocked <question>                 success, `TICKET: blocked <question>`
 *   FAKE:failed <reason>                    success, `TICKET: failed <reason>`
 *   FAKE:max-turns                          result `error_max_turns`
 *   FAKE:ratelimit [session|weekly|opus] [resets 3:45pm | resets +<ms>]   (+<ms> is sent to millisecond precision;
 *                                           the real SDK sends whole seconds, which the usage module also accepts)
 *   FAKE:sleep <ms> then <one of the above> wait first (abortable)
 *   FAKE:crash                              throw mid-stream
 *   FAKE:tools [{"tool":"status","args":{...}}, ...] then <one of the above>
 *                                           call the worker's `salu` tools (status, ask_decision, attach, start_thread) first
 *
 * Anything else counts as `FAKE:done`. The probe honours `SALU_FAKE_LIMIT_UNTIL=<epoch ms>` or
 * a file `fake-limit-until` in SALU_HOME holding that number: closed until then, open after.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ticketHome } from '../core/paths.ts';
import { openDb } from '../db/db.ts';
import { callTool } from '../threads/tool.ts';
import type { LimitHit } from '../usage/types.ts';
import type { WorkerInput, WorkerRunner } from './types.ts';

const KIND_TEXT: Record<string, string> = { session: 'session', weekly: 'weekly', opus: 'Opus', sonnet: 'Sonnet' };

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function clock(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}${ampm}`;
}

export function fakeLimitUntil(): number | null {
  const env = process.env.SALU_FAKE_LIMIT_UNTIL;
  if (env) return Number(env) || null;
  try {
    const f = join(ticketHome(), 'fake-limit-until');
    if (existsSync(f)) return Number(readFileSync(f, 'utf8').trim()) || null;
  } catch {
    /* ignore */
  }
  return null;
}

let counter = 0;

export const fakeRunner: WorkerRunner = {
  name: 'fake',
  async *run(input: WorkerInput) {
    const t = input.ticket;
    const sessionId = input.resume ?? `fake-${t.id}-${Date.now().toString(36)}-${++counter}`;
    const base = { session_id: sessionId, uuid: `${sessionId}-${counter}-${Date.now()}` };
    // A follow-up is its own script when it starts with FAKE:, otherwise the worker just does it.
    let script = input.followUp?.length ? input.followUp[input.followUp.length - 1]!.trim() : t.query.trim();
    if (input.followUp?.length && !/^FAKE:/i.test(script)) script = `FAKE:done Follow-up done: ${script}`;
    yield { type: 'ticket_start', ts: Date.now(), ticket_id: t.id, name: t.name, project: t.project, resume: !!input.resume, runner: 'fake', options: { model: 'fake', cwd: t.project_path } };
    const tools = /^FAKE:tools\s+(\[.*?\])\s+then\s+(.*)$/is.exec(script);
    if (tools) {
      script = tools[2]!.trim();
      yield { ...base, type: 'system', subtype: 'init', model: 'fake', cwd: t.project_path, tools: ['Bash', 'Read', 'Edit'], claude_code_version: 'fake', apiKeySource: 'none', permissionMode: 'acceptEdits', mcp_servers: [], slash_commands: [], output_style: 'default', skills: [], plugins: [] };
      let calls: Array<{ tool: string; args: unknown }> = [];
      try {
        calls = JSON.parse(tools[1]!);
      } catch {
        /* a bad script just makes no calls */
      }
      for (const [i, c] of calls.entries()) {
        const r = callTool({ db: openDb(), ticket: t }, c.tool, c.args);
        yield { ...base, type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: `st${i}`, name: `mcp__salu__${c.tool}`, input: c.args }] } };
        yield { ...base, type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `st${i}`, content: r.text, is_error: !!r.error }] } };
      }
    }
    const sleep = /^FAKE:sleep\s+(\d+)\s+then\s+(.*)$/is.exec(script);
    if (sleep) {
      script = sleep[2]!.trim();
      yield { ...base, type: 'system', subtype: 'init', model: 'fake', cwd: t.project_path, tools: ['Bash', 'Read', 'Edit'], claude_code_version: 'fake', apiKeySource: 'none', permissionMode: 'acceptEdits', mcp_servers: [], slash_commands: [], output_style: 'default', skills: [], plugins: [] };
      yield { ...base, type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: `sleep ${Number(sleep[1]) / 1000}` } }] } };
      await sleepAbortable(Number(sleep[1]), input.abort.signal);
      if (input.abort.signal.aborted) throw new Error('aborted');
    } else {
      yield { ...base, type: 'system', subtype: 'init', model: 'fake', cwd: t.project_path, tools: ['Bash', 'Read', 'Edit'], claude_code_version: 'fake', apiKeySource: 'none', permissionMode: 'acceptEdits', mcp_servers: [], slash_commands: [], output_style: 'default', skills: [], plugins: [] };
    }
    const m = /^FAKE:(\S+)\s*(.*)$/is.exec(script);
    const verb = (m?.[1] ?? 'done').toLowerCase();
    const rest = (m?.[2] ?? '').trim();
    const finish = (extra: Record<string, unknown>) => ({ ...base, type: 'result', duration_ms: 10, duration_api_ms: 5, is_error: false, num_turns: 2, total_cost_usd: 0.0123, stop_reason: 'end_turn', usage: {}, modelUsage: {}, permission_denials: [], errors: [], ...extra });

    yield { ...base, type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: `${t.project_path}/README.md` } }] } };
    yield { ...base, type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'hello' }] } };

    switch (verb) {
      case 'crash':
        throw new Error('fake worker crashed');
      case 'max-turns':
        yield finish({ subtype: 'error_max_turns', is_error: true, num_turns: 50, errors: ['Reached max turns (50)'] });
        return;
      case 'ratelimit': {
        const parts = rest.split(/\s+/).filter(Boolean);
        const kind = parts[0] && KIND_TEXT[parts[0].toLowerCase()] ? parts[0].toLowerCase() : 'session';
        let resetsAt: number | null = null;
        const ri = parts.findIndex((p) => p.toLowerCase() === 'resets');
        if (ri >= 0 && parts[ri + 1]) {
          const v = parts.slice(ri + 1).join(' ');
          resetsAt = v.startsWith('+') ? Date.now() + Number(v.slice(1)) : null;
          if (!resetsAt) {
            const text = `You've hit your ${KIND_TEXT[kind]} limit · resets ${v}`;
            yield finish({ subtype: 'success', is_error: true, result: text });
            return;
          }
        }
        const rateLimitType = kind === 'weekly' ? 'seven_day' : kind === 'opus' ? 'seven_day_opus' : kind === 'sonnet' ? 'seven_day_sonnet' : 'five_hour';
        yield { ...base, type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType, ...(resetsAt ? { resetsAt } : {}) } };
        const text = `You've hit your ${KIND_TEXT[kind]} limit · resets ${resetsAt ? clock(resetsAt) : 'later'}`;
        yield finish({ subtype: 'success', is_error: true, result: text });
        return;
      }
      case 'blocked':
        yield { ...base, type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: `I need a decision.\n\nTICKET: blocked ${rest || 'which option?'}` }] } };
        yield finish({ subtype: 'success', result: `I need a decision.\n\nTICKET: blocked ${rest || 'which option?'}` });
        return;
      case 'failed':
        yield finish({ subtype: 'success', result: `Cannot do this.\n\nTICKET: failed ${rest || 'no reason given'}` });
        return;
      default: {
        const text = `${rest || 'Did the work.'}\n\nTICKET: done`;
        yield { ...base, type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } };
        yield finish({ subtype: 'success', result: text });
      }
    }
  },
  async probe(): Promise<'ok' | LimitHit> {
    const until = fakeLimitUntil();
    if (until && until > Date.now()) return { kind: 'session', resetsAt: until, models: [], source: 'usage_probe', raw: `fake limit until ${new Date(until).toISOString()}` };
    return 'ok';
  },
};
