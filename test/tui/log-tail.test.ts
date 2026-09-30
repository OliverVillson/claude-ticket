import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderLogLine, tailLog } from '../../src/tui/log-tail.ts';

const line = (o: unknown) => JSON.stringify(o);

describe('log rendering', () => {
  test('tool calls, text and results', () => {
    expect(renderLogLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] } }))).toEqual([{ kind: 'tool', text: 'Read(a.ts)' }]);
    expect(renderLogLine(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello\nthere' }] } }))).toEqual([{ kind: 'text', text: 'hello there' }]);
    const r = renderLogLine(line({ type: 'result', subtype: 'success', num_turns: 4, total_cost_usd: 0.1234, result: 'TICKET: done' }));
    expect(r.at(-1)).toEqual({ kind: 'result', text: 'success · 4 turns · $0.12' });
  });
  test('errors and rate limits', () => {
    expect(renderLogLine(line({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 50 })).at(-1)!.kind).toBe('error');
    expect(renderLogLine(line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } }))[0]!.kind).toBe('error');
    expect(renderLogLine(line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }))).toEqual([]);
    expect(renderLogLine(line({ type: 'worker_error', error: 'boom' }))[0]).toEqual({ kind: 'error', text: 'worker error: boom' });
  });
  test('worker start, init and subagent chatter', () => {
    expect(renderLogLine(line({ type: 'ticket_start', resume: true, options: { model: 'opus', effort: 'high', maxTurns: 50 } }))[0]!.text).toBe('resuming · opus · high · max 50 turns');
    expect(renderLogLine(line({ type: 'system', subtype: 'init', model: 'claude-opus-4-1' }))[0]!.text).toBe('session started · claude-opus-4-1');
    expect(renderLogLine(line({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'text', text: 'sub' }] } }))).toEqual([]);
  });
  test('garbage falls back to raw and blanks vanish', () => {
    expect(renderLogLine('not json')).toEqual([{ kind: 'raw', text: 'not json' }]);
    expect(renderLogLine('   ')).toEqual([]);
  });
  test('tailLog reads the end of a file and survives missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ticket-log-'));
    const path = join(dir, '1-1.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `step ${i}` } }] } }));
    writeFileSync(path, lines.join('\n') + '\n');
    const tail = tailLog(path, 3);
    expect(tail.map((l) => l.text)).toEqual(['Bash(step 27)', 'Bash(step 28)', 'Bash(step 29)']);
    expect(tailLog(join(dir, 'nope.jsonl'))).toEqual([]);
    expect(tailLog(null)).toEqual([]);
  });
});
