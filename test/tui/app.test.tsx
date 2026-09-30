import React from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { render } from 'ink';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from '../../src/tui/app.tsx';
import { RunView } from '../../src/tui/components/RunView.tsx';
import { defaultActions } from '../../src/tui/actions.ts';
import { createRun, getTicketById, listTickets, setState } from '../../src/db/queries.ts';
import { STATE } from '../../src/db/types.ts';
import { clearPause, readStatus, setPause, writeWorkerInfo } from '../../src/orchestrator/status.ts';
import type { OrchestratorEvent } from '../../src/orchestrator/types.ts';
import { KEY, fakeTerminal, seedDb, sleep } from './harness.ts';

type Instance = ReturnType<typeof render>;
const open: Instance[] = [];
afterEach(() => {
  while (open.length) {
    try {
      open.pop()!.unmount();
    } catch {
      /* already gone */
    }
  }
});

function mountApp(props: Partial<React.ComponentProps<typeof App>> & { db: any }, size: [number, number] = [100, 24]) {
  const term = fakeTerminal(...size);
  const inst = render(<App projectId={null} actions={defaultActions(props.db)} pollMs={100} {...props} />, {
    stdout: term.stdout,
    stdin: term.stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  open.push(inst);
  return { term, inst };
}

describe('list view', () => {
  test('renders names, statuses, priorities, header counts and hints', async () => {
    const { db } = seedDb(12);
    const { term } = mountApp({ db });
    const f = await term.waitFor((s) => s.includes('ticket 001'), 'first frame');
    expect(f).toContain('▌salu › all projects');
    expect(f).toContain('ticket 012');
    expect(f).toContain('running');
    expect(f).toContain('failed');
    expect(f).toContain('#bug');
    expect(f).toContain('opus/high');
    expect(f).toContain('2 running');
    expect(f).toContain('orchestrator off');
    expect(f).toContain('↑↓ move');
    expect(f).toContain('1/12');
    expect(f).toContain('❯');
    expect(f).toContain('╭');
    expect(f).toContain('╰');
  });

  test('arrow keys and j/k move the cursor, g/G jump', async () => {
    const { db } = seedDb(12);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/12'));
    await term.press(KEY.down);
    await term.press(KEY.down);
    expect(term.lastFrame()).toContain('3/12');
    await term.press('k');
    expect(term.lastFrame()).toContain('2/12');
    await term.press('j');
    await term.press('j');
    expect(term.lastFrame()).toContain('4/12');
    await term.press('G');
    expect(term.lastFrame()).toContain('12/12');
    await term.press(KEY.down); // stays on the last row
    expect(term.lastFrame()).toContain('12/12');
    await term.press('g');
    expect(term.lastFrame()).toContain('1/12');
    await term.press(KEY.up);
    expect(term.lastFrame()).toContain('1/12');
  });

  test('cursor row is marked and a windowed list scrolls with a "more" hint', async () => {
    const { db } = seedDb(60);
    const { term } = mountApp({ db }, [100, 14]);
    const first = await term.waitFor((s) => s.includes('1/60'));
    expect(first).toContain('↓');
    expect(first).toContain('more');
    const rowsShown = first.split('\n').filter((l) => l.includes('ticket ')).length;
    expect(rowsShown).toBeLessThan(12);
    await term.press('G');
    const last = term.lastFrame();
    expect(last).toContain('60/60');
    expect(last).toContain('↑');
    const lines = last.split('\n');
    expect(lines.filter((l) => l.includes('❯')).length).toBe(1);
    // the last row of the sorted list (done tickets sort last) is the selected one, on the last body line
    const body = lines.filter((l) => l.startsWith('│'));
    expect(body.at(-2)).toContain('❯');
    // no line is wider than the terminal
    expect(lines.every((l) => [...l].length <= 100)).toBe(true);
  });

  test('/ filters as you type, esc clears', async () => {
    const { db } = seedDb(12);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/12'));
    await term.press('/');
    expect(term.lastFrame()).toContain('/ ');
    await term.press('status:failed');
    const f = term.lastFrame();
    expect(f).toContain('2 of 12 match');
    expect(f).toContain('ticket 005');
    expect(f).toContain('ticket 011');
    expect(f).not.toContain('ticket 001');
    await term.press(KEY.enter);
    expect(term.lastFrame()).toContain('› /status:failed');
    expect(term.lastFrame()).toContain('1/2');
    await term.press(KEY.esc);
    const cleared = await term.waitFor((s) => s.includes('1/12'), 'filter cleared');
    expect(cleared).toContain('ticket 001');
  });

  test('a filter with no hits says so', async () => {
    const { db } = seedDb(6);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/6'));
    await term.press('/');
    await term.press('zzzz');
    expect(term.lastFrame()).toContain('nothing matches "zzzz"');
  });

  test('tab cycles projects and shows only their tickets', async () => {
    const { db } = seedDb(12);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('all projects'));
    await term.press(KEY.tab);
    let f = await term.waitFor((s) => s.includes('salu › web'), 'web');
    expect(f).toContain('ticket 001');
    expect(f).not.toContain('ticket 002');
    await term.press(KEY.tab);
    f = await term.waitFor((s) => s.includes('salu › api'), 'api');
    expect(f).toContain('ticket 002');
    expect(f).not.toContain('ticket 001');
    await term.press(KEY.tab);
    await term.waitFor((s) => s.includes('all projects'), 'all again');
    await term.press(KEY.shiftTab);
    await term.waitFor((s) => s.includes('salu › api'), 'shift-tab goes back');
  });

  test('a status scope from --status shows in the header and limits rows', async () => {
    const { db } = seedDb(12);
    const { term } = mountApp({ db, statuses: ['failed'] });
    const f = await term.waitFor((s) => s.includes('ticket 005'));
    expect(f).toContain('failed');
    expect(f).not.toContain('ticket 001');
  });

  test('picks up changes made elsewhere while open', async () => {
    const { db } = seedDb(6);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/6'));
    const { createTicket } = await import('../../src/db/queries.ts');
    createTicket(db, { project_id: 1, name: 'appeared later', query: 'x' });
    await term.waitFor((s) => s.includes('appeared later'), 'polled ticket');
    expect(term.lastFrame()).toContain('1/7');
  });

  test('empty database shows the hint to add a ticket', async () => {
    const { db } = seedDb(0);
    const { term } = mountApp({ db });
    const f = await term.waitFor((s) => s.includes('no tickets yet'));
    expect(f).toContain('press a to add one');
  });

  test('help opens with ? and closes on any key', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/3'));
    await term.press('?');
    expect(term.lastFrame()).toContain('move the cursor');
    await term.press('x');
    expect(term.lastFrame()).toContain('1/3');
  });
});

describe('ticket actions from the list', () => {
  test('d then y deletes, d then n keeps', async () => {
    const { db, ids } = seedDb(6);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/6'));
    await term.press(KEY.down);
    await term.press('d');
    expect(term.lastFrame()).toContain('delete "ticket');
    await term.press('n');
    expect(listTickets(db).length).toBe(6);
    await term.press('d');
    await term.press('y');
    await term.waitFor((s) => s.includes('deleted'), 'deleted message');
    expect(listTickets(db).length).toBe(5);
    // the list sorts running, then todo by priority: the second row is ticket 002
    expect(listTickets(db).some((t) => t.id === ids[1])).toBe(false);
    expect(listTickets(db).some((t) => t.id === ids[0])).toBe(true);
  });

  test('r sets priority 0 (now) on a queued ticket and hints when the orchestrator is off', async () => {
    const { db } = seedDb(6);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/6'));
    await term.press(KEY.down); // ticket 007? the second row is a running one; move to a todo row
    await term.press(KEY.down);
    const before = listTickets(db);
    const target = before[2]!;
    expect(target.status).toBe('todo');
    await term.press('r');
    await term.waitFor((s) => s.includes('runs next'), 'run-now message');
    const after = getTicketById(db, target.id)!;
    expect(after.priority).toBe(0);
    expect(after.status).toBe('todo');
    expect(term.lastFrame()).toContain('salu run');
    await term.waitFor((s) => /\bnow\b/.test(s.split('\n').find((l) => l.includes(target.name)) ?? ''), 'priority column reads now');
  });

  test('r on a done ticket re-queues it', async () => {
    const { db } = seedDb(6);
    const done = listTickets(db).find((t) => t.status === 'done')!;
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/6'));
    await term.press('/');
    await term.press(done.name);
    await term.press(KEY.enter);
    await term.press('r');
    await sleep(80);
    const after = getTicketById(db, done.id)!;
    expect(after.status).toBe('todo');
    expect(after.priority).toBe(0);
  });

  test('r on a running ticket does nothing', async () => {
    const { db } = seedDb(6);
    const running = listTickets(db).find((t) => t.status === 'running')!;
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/6'));
    await term.press('r'); // first row is the running ticket
    expect(getTicketById(db, running.id)!.priority).toBe(running.priority);
    expect(term.lastFrame()).toContain('already running');
  });

  test('p pauses and resumes through the orchestrator state', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/3'));
    await term.press('p');
    expect(readStatus(db).paused?.manual).toBe(true);
    await term.waitFor((s) => s.includes('‖ paused'), 'paused badge');
    await term.press('p', 100);
    expect(readStatus(db).paused).toBeNull();
    await term.waitFor((s) => !s.includes('‖ paused'), 'badge cleared');
  });

  test('a rate-limit pause shows its kind and a countdown', async () => {
    const { db } = seedDb(3);
    setPause(db, { until: Date.now() + 42 * 60_000, reason: 'session limit', kind: 'session' });
    const { term } = mountApp({ db });
    const f = await term.waitFor((s) => s.includes('paused'));
    expect(f).toContain('session limit');
    expect(f).toMatch(/resumes in 4[12]m/);
    clearPause(db);
  });

  test('a live orchestrator shows as on with its workers', async () => {
    const { db } = seedDb(3);
    setState(db, STATE.pid, process.pid);
    setState(db, STATE.heartbeat, Date.now());
    writeWorkerInfo(db, { ticketId: 1, runId: 1, startedAt: Date.now(), turns: 2, lastTool: 'Read', lastText: null, model: 'opus', sessionId: null, updatedAt: Date.now() });
    const { term } = mountApp({ db });
    const f = await term.waitFor((s) => s.includes('orchestrator on'));
    expect(f).toContain('1 worker');
  });
});

describe('add and edit form', () => {
  test('a adds a ticket to the current project with tags and priority', async () => {
    const { db, web } = seedDb(3);
    const { term } = mountApp({ db, projectId: web.id });
    await term.waitFor((s) => s.includes('salu › web'));
    await term.press('a');
    expect(term.lastFrame()).toContain('new ticket');
    await term.press('Ship the thing');
    await term.press(KEY.tab);
    await term.press('Build it and test it');
    await term.press(KEY.tab);
    await term.press('model=opus effort=high docs');
    await term.press(KEY.tab);
    await term.press(KEY.backspace);
    await term.press('1');
    await term.press(KEY.enter);
    await term.waitFor((s) => s.includes('added "Ship the thing"'), 'added message');
    const t = listTickets(db).find((x) => x.name === 'Ship the thing')!;
    expect(t.project_id).toBe(web.id);
    expect(t.query).toBe('Build it and test it');
    expect(JSON.parse(t.tags)).toEqual({ model: 'opus', effort: 'high' });
    expect(JSON.parse(t.labels)).toEqual(['docs']);
    expect(t.priority).toBe(1);
    expect(t.status).toBe('todo');
  });

  test('priority "now" is accepted', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/3'));
    await term.press('a');
    await term.press('Urgent');
    await term.press(KEY.tab);
    await term.press('do it');
    await term.press(KEY.tab);
    await term.press(KEY.tab);
    await term.press(KEY.backspace);
    await term.press('now');
    await term.press(KEY.enter);
    await term.waitFor((s) => s.includes('added "Urgent"'));
    expect(listTickets(db).find((x) => x.name === 'Urgent')!.priority).toBe(0);
  });

  test('enter with an empty name or query moves to that field instead of saving', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/3'));
    await term.press('a');
    await term.press(KEY.enter);
    expect(listTickets(db).length).toBe(3);
    await term.press('Only a name');
    await term.press(KEY.enter); // query empty: focus jumps there
    await term.press('now has a query');
    await term.press(KEY.enter);
    await term.waitFor((s) => s.includes('added "Only a name"'));
  });

  test('a validation error stays in the form and clears when you type', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/3'));
    await term.press('a');
    await term.press('Bad tags');
    await term.press(KEY.tab);
    await term.press('q');
    await term.press(KEY.tab);
    await term.press('effort=turbo');
    await term.press(KEY.enter);
    const f = await term.waitFor((s) => s.includes('effort must be one of'), 'error');
    expect(f).toContain('new ticket');
    expect(listTickets(db).some((t) => t.name === 'Bad tags')).toBe(false);
    await term.press(KEY.backspace);
    await term.waitFor((s) => !s.includes('effort must be one of'), 'error cleared');
  });

  test('a duplicate name is reported by the database layer', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db, projectId: 1 });
    await term.waitFor((s) => s.includes('salu › web'));
    await term.press('a');
    await term.press('ticket 001');
    await term.press(KEY.tab);
    await term.press('dup');
    await term.press(KEY.enter);
    await term.waitFor((s) => s.includes('already exists'), 'duplicate error');
  });

  test('esc cancels the form without saving', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/3'));
    await term.press('a');
    await term.press('draft');
    await term.press(KEY.esc);
    await term.waitFor((s) => s.includes('1/3'), 'back to the list');
    expect(listTickets(db).length).toBe(3);
  });

  test('e edits the selected ticket in place, priority and tags round-trip', async () => {
    const { db, ids } = seedDb(6);
    const target = getTicketById(db, ids[0]!)!; // ticket 001: opus/high, #bug, running, p1
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/6'));
    await term.press('e');
    const f = term.lastFrame();
    expect(f).toContain('edit ' + target.name);
    expect(f).toContain('model=opus');
    expect(f).toContain('effort=high');
    expect(f).toContain('bug');
    await term.press('!'); // cursor starts at the end of name
    await term.press(KEY.enter);
    await term.waitFor((s) => s.includes('saved "ticket 001!"'), 'saved message');
    const after = getTicketById(db, target.id)!;
    expect(after.name).toBe('ticket 001!');
    expect(JSON.parse(after.tags)).toEqual({ model: 'opus', effort: 'high' });
    expect(JSON.parse(after.labels)).toEqual(['bug']);
    expect(after.priority).toBe(target.priority);
    expect(after.query).toBe(target.query);
  });

  test('form opened on its own exits with the saved ticket', async () => {
    const { db, ids } = seedDb(3);
    const term = fakeTerminal(100, 24);
    let result: unknown = 'unset';
    const inst = render(<App db={db} projectId={null} actions={defaultActions(db)} form={{ ticketId: ids[1] }} />, {
      stdout: term.stdout,
      stdin: term.stdin,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    open.push(inst);
    inst.waitUntilExit().then((r) => (result = r));
    await term.waitFor((s) => s.includes('edit ticket 002'), 'standalone form');
    await term.press(KEY.tab);
    await term.press(' more');
    await term.press(KEY.enter);
    await sleep(100);
    expect((result as any)?.action).toBe('saved');
    expect(getTicketById(db, ids[1]!)!.query).toContain('more');
  });
});

describe('ticket detail', () => {
  test('enter opens the ticket with its query, tags, run summary and live log tail', async () => {
    const { db, home, ids } = seedDb(6);
    const t = getTicketById(db, ids[0]!)!; // running
    const dir = join(home, 'logs', 'web');
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, `${t.id}-1.jsonl`);
    writeFileSync(
      logPath,
      [
        JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-1' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/auth.ts' } }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Found the null check.' }] } }),
      ].join('\n') + '\n',
    );
    createRun(db, t.id, logPath);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/6'));
    await term.press(KEY.enter);
    const f = await term.waitFor((s) => s.includes('Read(src/auth.ts)'), 'log tail');
    expect(f).toContain('salu › all projects › ticket 001'.replace('all projects', 'web'));
    expect(f).toContain(t.query);
    expect(f).toContain('opus/high');
    expect(f).toContain('#bug');
    expect(f).toContain('Found the null check.');
    expect(f).toContain('last run');
    expect(f).toContain('esc back');
    await term.press(KEY.esc);
    await term.waitFor((s) => s.includes('1/6'), 'back to list');
  });

  test('a failed ticket shows its error', async () => {
    const { db } = seedDb(6);
    const failed = listTickets(db).find((t) => t.status === 'failed')!;
    const { updateTicket } = await import('../../src/db/queries.ts');
    updateTicket(db, failed.id, { error: 'error_max_turns: hit the cap' });
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/6'));
    await term.press('/');
    await term.press(failed.name);
    await term.press(KEY.enter);
    await term.press(KEY.enter);
    const f = await term.waitFor((s) => s.includes('error_max_turns'), 'error line');
    expect(f).toContain('✗');
  });

  test('up/down in the detail view move to the neighbouring ticket', async () => {
    const { db } = seedDb(6);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/6'));
    await term.press(KEY.enter);
    const first = await term.waitFor((s) => s.includes('#'));
    await term.press(KEY.down);
    await sleep(100);
    expect(term.lastFrame()).not.toEqual(first);
  });

  test('deleting from the detail view returns to the list', async () => {
    const { db } = seedDb(6);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/6'));
    await term.press(KEY.enter);
    await sleep(80);
    await term.press('d');
    expect(term.lastFrame()).toContain('delete "');
    await term.press('y');
    await term.waitFor((s) => s.includes('1/5'), 'list with one fewer');
    expect(listTickets(db).length).toBe(5);
  });
});

describe('run view', () => {
  test('shows workers, the queue, activity from events, and stops on q', async () => {
    const { db } = seedDb(6);
    setState(db, STATE.pid, process.pid);
    setState(db, STATE.heartbeat, Date.now());
    const running = listTickets(db).find((t) => t.status === 'running')!;
    writeWorkerInfo(db, { ticketId: running.id, runId: 1, startedAt: Date.now() - 65_000, turns: 7, lastTool: 'Edit(src/a.ts)', lastText: null, model: 'claude-opus-4-1', sessionId: 's', updatedAt: Date.now() });
    let listener: ((e: OrchestratorEvent) => void) | null = null;
    let stopped = 0;
    const term = fakeTerminal(110, 24);
    const inst = render(
      <RunView
        db={db}
        concurrency={2}
        stop={() => {
          stopped++;
        }}
        subscribe={(fn) => {
          listener = fn;
          return () => {
            listener = null;
          };
        }}
        actions={defaultActions(db)}
        pollMs={100}
      />,
      { stdout: term.stdout, stdin: term.stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );
    open.push(inst);
    const f = await term.waitFor((s) => s.includes(running.name) && s.includes('Edit(src/a.ts)') && s.includes('next:'), 'worker row and queue');
    expect(f).toContain('▌salu › run');
    expect(f).toContain('1/2 workers');
    expect(f).toContain('7 turns');
    expect(f).toContain('1m');
    expect(f).toContain('opus-4-1');
    expect(f).toContain('next:');
    expect(f).toContain('orchestrator on');

    const ticket = getTicketById(db, running.id)!;
    listener!({ type: 'finish', ticket, outcome: 'done', costUsd: 0.42, turns: 14, status: 'done', durationMs: 90_000 });
    listener!({ type: 'pause', until: Date.now() + 3600_000, reason: 'session limit', kind: 'session', models: [] });
    const g = await term.waitFor((s) => s.includes('activity') && s.includes('done ·'), 'activity lines');
    expect(g).toContain('$0.42');
    expect(g).toContain('paused');

    await term.press('q');
    expect(stopped).toBe(1);
    expect(term.lastFrame()).toContain('stopping');
  });
});
