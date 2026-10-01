import React from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { render } from 'ink';
import { App } from '../../src/tui/app.tsx';
import { defaultActions } from '../../src/tui/actions.ts';
import { addTurn, createRun, finishRun, getTicketById, listTickets, updateTicket } from '../../src/db/queries.ts';
import { layoutThread, partitionResolved, conversationLines, type ThreadInput } from '../../src/tui/thread.ts';
import { loadDetail } from '../../src/tui/store.ts';
import { renderRow } from '../../src/tui/rows.ts';
import { computeLayout } from '../../src/tui/layout.ts';
import { displayWidth } from '../../src/tui/format.ts';
import { style as st } from '../../src/tui/style.ts';
import { addDecision, addOutput, setChecklist, listDecisions } from '../../src/threads/store.ts';
import { listTurns } from '../../src/db/queries.ts';
import { KEY, fakeTerminal, seedDb, stripAnsi } from './harness.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const open: Array<ReturnType<typeof render>> = [];
afterEach(() => {
  while (open.length) {
    try {
      open.pop()!.unmount();
    } catch {
      /* gone */
    }
  }
});

function mountApp(props: Partial<React.ComponentProps<typeof App>> & { db: any }, size: [number, number]) {
  const term = fakeTerminal(...size);
  const inst = render(<App projectId={null} actions={defaultActions(props.db)} pollMs={100} {...props} />, { stdout: term.stdout, stdin: term.stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
  open.push(inst);
  return term;
}

/** A finished thread with a branch, two exchanges and a log of tool calls. */
function seedThread() {
  const { db, home, ids } = seedDb(6);
  const t = getTicketById(db, ids[3]!)!; // done
  const logPath = join(home, 'logs', 'web', `${t.id}-1.jsonl`);
  mkdirSync(join(home, 'logs', 'web'), { recursive: true });
  const tool = (name: string, input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  writeFileSync(logPath, [tool('Read', { file_path: 'a.ts' }), tool('Read', { file_path: 'b.ts' }), tool('Edit', { file_path: 'a.ts' })].join('\n') + '\n');
  const run = createRun(db, t.id, logPath);
  finishRun(db, run.id, { outcome: 'done', turns: 14, cost_usd: 0.42 });
  updateTicket(db, t.id, { branch: 'salu/ticket-004' });
  addTurn(db, t.id, 'assistant', 'Found it: the callback dropped `next`. Fixed and added a test.');
  addTurn(db, t.id, 'user', 'Also cover the logout path.', false);
  return { db, ticket: getTicketById(db, t.id)!, input: (): ThreadInput => ({ detail: loadDetail(db, getTicketById(db, t.id)!), log: [], now: Date.now() }) };
}

describe('thread view model', () => {
  test('the conversation has every message in order, the did line and the pending note', () => {
    const { input } = seedThread();
    const text = conversationLines(input(), 60, st).map(stripAnsi).join('\n');
    expect(text.indexOf('you')).toBeLessThan(text.indexOf('salu'));
    expect(text.indexOf('salu')).toBeLessThan(text.indexOf('Also cover the logout path.'));
    expect(text).toContain('Read ×2 · Edit');
    expect(text).toContain('14 turns');
    expect(text).toContain('(waiting for the worker)');
  });

  test('layout fills exactly the height, pins outputs and scrolls back', () => {
    const { input } = seedThread();
    const b = layoutThread(input(), 50, 12, 0, st);
    expect(b.lines.length).toBe(12);
    for (const l of b.lines) expect(displayWidth(l)).toBeLessThanOrEqual(50);
    const plain = b.lines.map(stripAnsi).join('\n');
    expect(plain).toContain('outputs');
    expect(plain).toContain('branch salu/ticket-004');
    const tiny = layoutThread(input(), 50, 9, 0, st);
    expect(tiny.above).toBeGreaterThan(0);
    const older = layoutThread(input(), 50, 9, 2, st);
    expect(older.below).toBe(2);
    expect(stripAnsi(older.lines.join('\n'))).toContain('outputs');
  });

  test('a clean slot: no checklist yet means no crash, a checklist renders when given', () => {
    const { input } = seedThread();
    const i = input();
    const withList = layoutThread({ ...i, extras: { checklist: [{ text: 'reproduced', state: 'done' }, { text: 'running tests', state: 'active' }, { text: 'docs', state: 'todo' }], outputs: [{ kind: 'pr', ref: '#71' }] } }, 60, 12, 0, st);
    const plain = withList.lines.map(stripAnsi).join('\n');
    expect(plain).toContain('✓ reproduced');
    expect(plain).toContain('running tests');
    expect(plain).toContain('PR #71');
  });

  test('resolved threads sort to the bottom and collapse to one line', () => {
    const rows = [{ status: 'done', n: 'a' }, { status: 'failed', n: 'b' }, { status: 'done', n: 'c' }, { status: 'todo', n: 'd' }];
    expect(partitionResolved(rows).map((r) => r.n)).toEqual(['b', 'd', 'a', 'c']);
    const { ticket } = seedThread();
    const row = renderRow({ ...ticket, status: 'done', name: 'rename-config' }, { layout: computeLayout(60), now: Date.now(), style: st });
    const plain = stripAnsi(row);
    expect(plain).toContain('✓ rename-config');
    expect(plain).not.toContain('p3');
    expect(displayWidth(row)).toBeLessThanOrEqual(60);
    // with an unanswered decision it stays a full row, marked with ?, and keeps its place among the open ones
    const asking = stripAnsi(renderRow({ ...ticket, status: 'done', name: 'add-rate-limit' }, { layout: computeLayout(60), now: Date.now(), style: st, asking: true }));
    expect(asking).toMatch(/add-rate-limit\s+\?/);
    expect(asking).toContain('resolved');
    expect(displayWidth(asking)).toBeLessThanOrEqual(60);
    const rows2 = [{ id: 1, status: 'done' }, { id: 2, status: 'done' }, { id: 3, status: 'todo' }];
    expect(partitionResolved(rows2, new Set([2])).map((r) => r.id)).toEqual([2, 3, 1]);
  });
});

describe('thread view in the app', () => {
  test('a wide terminal shows the selected conversation beside the list; tab reaches it; x on a resolved one says so', async () => {
    const { db, ticket } = seedThread();
    const term = mountApp({ db }, [170, 34]);
    await term.waitFor((s) => s.includes('1/6'));
    await term.press('/');
    await term.press(ticket.name);
    await term.press(KEY.enter);
    const f = await term.waitFor((s) => s.includes('Found it: the callback'), 'conversation in the third pane');
    expect(f).toContain('outputs');
    expect(f).toContain('branch salu/ticket-004');
    await term.press(KEY.tab); // tree -> tickets
    await term.press(KEY.tab); // tickets -> thread
    expect(term.lastFrame()).toContain('r reply');
    await term.press('x');
    expect(term.lastFrame()).toContain('already resolved');
    await term.press('r');
    await term.waitFor((s) => s.includes('your message'), 'reply prompt');
    await term.press(KEY.esc);
    await term.waitFor((s) => s.includes('1 of 6 match') && !s.includes('your message'), 'back to the lists');
  });

  test('x resolves a failed thread from the thread screen and it collapses to the bottom', async () => {
    const { db } = seedThread();
    const failed = listTickets(db).find((t) => t.status === 'failed')!;
    const term = mountApp({ db }, [100, 28]);
    await term.waitFor((s) => s.includes('1/6'));
    await term.press('/');
    await term.press(failed.name);
    await term.press(KEY.enter);
    await term.press(KEY.enter); // open the thread
    await term.waitFor((s) => s.includes('x resolve'));
    await term.press('x');
    await term.waitFor((s) => s.includes('resolved · r replies'), 'resolve message');
    expect(getTicketById(db, failed.id)!.status).toBe('done');
  });

  test('the worker checklist, outputs and sub-threads render; a number key answers the open decision', async () => {
    const { db, ticket } = seedThread();
    setChecklist(db, ticket.id, [{ text: 'reproduced', state: 'done' }, { text: 'running tests', state: 'doing' }, { text: 'docs', state: 'todo' }]);
    addOutput(db, ticket.id, { kind: 'pr', ref: 'https://github.com/o/r/pull/71', title: 'PR #71' });
    addOutput(db, ticket.id, { kind: 'branch', ref: 'salu/ticket-004' }); // same as the ticket's own branch: shown once
    const d = addDecision(db, ticket.id, { question: 'Rename the config key?', options: [{ label: 'Keep it', consequence: 'no migration' }, { label: 'Rename', consequence: 'needs a migration' }], recommended: 0 });
    const term = mountApp({ db }, [100, 30]);
    await term.waitFor((s) => s.includes('1/6'));
    await term.press('/');
    await term.press(ticket.name);
    await term.press(KEY.enter);
    await term.press(KEY.enter);
    const f = await term.waitFor((s) => s.includes('Rename the config key?'), 'decision card');
    expect(f).toContain('1 Keep it (recommended)');
    expect(f).toContain('✓ reproduced');
    expect(f).toContain('running tests');
    expect(f).toContain('PR #71');
    expect(f.match(/salu\/ticket-004/g)!.length).toBe(1);
    expect(f).toContain('1-4 answer');
    await term.press('2');
    await term.waitFor((s) => s.includes('picked "Rename"'), 'answer message');
    expect(listDecisions(db, ticket.id)[0]).toMatchObject({ id: d.id, status: 'answered', chosen: 1 });
    expect(listTurns(db, ticket.id).at(-1)!.body).toContain('chose "Rename"');
    expect(getTicketById(db, ticket.id)!.status).toBe('todo');
  });

  test('o expands the outputs strip in the thread screen', async () => {
    const { db, ticket } = seedThread();
    const term = mountApp({ db }, [100, 28]);
    await term.waitFor((s) => s.includes('1/6'));
    await term.press('/');
    await term.press(ticket.name);
    await term.press(KEY.enter);
    await term.press(KEY.enter);
    await term.waitFor((s) => s.includes('Found it'));
    await term.press('o');
    expect(term.lastFrame()).toMatch(/branch\s+salu\/ticket-004/);
  });
});
