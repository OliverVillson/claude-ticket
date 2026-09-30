// Child process for palette.test.ts: renders the main screens with colour forced on and prints every frame.
import React from 'react';
import { render } from 'ink';
import { App } from '../../src/tui/app.tsx';
import { defaultActions } from '../../src/tui/actions.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRun } from '../../src/db/queries.ts';
import { KEY, fakeTerminal, seedDb } from './harness.ts';

const { db, home, ids } = seedDb(12);
// a worker log with every kind of line, so the activity area is scanned too
mkdirSync(join(home, 'logs'), { recursive: true });
const logPath = join(home, 'logs', 'w.jsonl');
const msg = (content: object[]) => ({ type: 'assistant', message: { content } });
writeFileSync(
  logPath,
  [
    { type: 'ticket_start', options: { model: 'claude-opus-5-5', effort: 'medium' } },
    msg([{ type: 'text', text: 'Reading the auth middleware and fixing the null check.' }]),
    msg([{ type: 'tool_use', name: 'Read', input: { file_path: 'src/auth.ts' } }]),
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'ENOENT: no such file' }] } },
    { type: 'result', subtype: 'success', num_turns: 4, total_cost_usd: 0.12, result: 'TICKET: done' },
  ]
    .map((l) => JSON.stringify(l))
    .join('\n') + '\n',
);
createRun(db, ids[0]!, logPath);
const frames: string[] = [];

const usageOf = (used: number) => ({ get: () => ({ available: true, stale: false, fetchedAt: Date.now(), windows: [{ key: 'five_hour', label: '5h', usedPercent: used, status: 'ok' as const, resetsAt: Date.now() + 3_600_000 }, { key: 'weekly', label: 'wk', usedPercent: 30, status: 'ok' as const, resetsAt: Date.now() + 3 * 86_400_000 }] }), subscribe: () => () => {} });

async function run(width: number, steps: string[], usage?: number) {
  const term = fakeTerminal(width, 34);
  const inst = render(<App db={db} projectId={null} actions={defaultActions(db)} pollMs={100} usage={usage == null ? undefined : usageOf(usage)} />, { stdout: term.stdout, stdin: term.stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
  await term.waitFor((s) => s.includes('ticket 001'));
  for (const k of steps) await term.press(k, 80);
  inst.unmount();
  frames.push(...term.frames);
}

// One pane (narrow): list, help, filter, delete confirm, detail, add form, command line.
await run(100, ['?', 'x', '/', 'zz', KEY.enter, KEY.esc, 'd', 'n', KEY.enter, 'x', KEY.esc, 'a', 'ab', KEY.tab, KEY.tab, KEY.esc, ':', 'sta', KEY.tab, KEY.enter, KEY.esc, KEY.esc]);
// Two panes (wide): project tree focused, move, open, tab to tickets, back with left, remove confirm.
await run(130, [':', 'add x', KEY.esc, KEY.tab, KEY.tab, 'f', 'f', '[', ']', KEY.tab, KEY.shiftTab, KEY.shiftTab, KEY.down, KEY.right, KEY.down, KEY.left, KEY.tab, KEY.down, KEY.left, 'd', 'n', 'a', KEY.esc, KEY.esc]);
// Properties (right on a ticket) with a pick-list and a text edit, then the tag groups in the new-ticket form.
await run(100, [KEY.right, KEY.down, KEY.down, KEY.down, KEY.down, KEY.right, KEY.down, KEY.esc, KEY.down, KEY.down, KEY.right, KEY.down, KEY.esc, KEY.down, KEY.down, KEY.down, KEY.down, KEY.right, '2', KEY.esc, KEY.left, 'a', 'n', KEY.tab, 'q', KEY.tab, KEY.right, KEY.right, KEY.right, KEY.down, KEY.left, KEY.down, KEY.right, KEY.right, KEY.left, KEY.left, KEY.left, KEY.esc]);
// Output section of the properties view (ticket 001 has a run with a log).
await run(100, [KEY.right, 'o', KEY.down, 'p', KEY.left]);
// Usage meter in the greens, amber and red.
for (const used of [40, 80, 97]) await run(130, [], used);
// Flush before exiting: process.exit() right after console.log truncates a large payload on a pipe.
process.stdout.write(JSON.stringify(frames) + '\n', () => process.exit(0));
