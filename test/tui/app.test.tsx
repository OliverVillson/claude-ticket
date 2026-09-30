import React from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { render } from 'ink';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from '../../src/tui/app.tsx';
import { RunView } from '../../src/tui/components/RunView.tsx';
import { defaultActions } from '../../src/tui/actions.ts';
import { createProject, createRun, createTicket, getTicketById, listProjects, listTickets, setState, updateTicket } from '../../src/db/queries.ts';
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
    expect(lines.filter((l) => l.includes('❯') && l.includes('ticket ')).length).toBe(1);
    // the last row of the sorted list (done tickets sort last) is the selected one, on the last body line
    const sel = lines.findIndex((l) => l.includes('❯') && l.includes('ticket '));
    expect(lines.slice(sel + 1).filter((l) => l.includes('ticket ')).length).toBe(0);
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

  test('in one pane < and > cycle projects and show only their tickets', async () => {
    const { db } = seedDb(12);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('all projects'));
    await term.press('>');
    let f = await term.waitFor((s) => s.includes('salu › web'), 'web');
    expect(f).toContain('ticket 001');
    expect(f).not.toContain('ticket 002');
    await term.press('>');
    f = await term.waitFor((s) => s.includes('salu › api'), 'api');
    expect(f).toContain('ticket 002');
    expect(f).not.toContain('ticket 001');
    await term.press('>');
    await term.waitFor((s) => s.includes('all projects'), 'all again');
    await term.press('<');
    await term.waitFor((s) => s.includes('salu › api'), '< goes back');
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

/** Drive the tag-group menu from the tags row: model/effort picks by index, labels text. */
async function setTags(term: any, o: { model?: number; effort?: number; labels?: string }) {
  await term.press(KEY.right); // open the groups
  if (o.model != null || o.effort != null) {
    await term.press(KEY.right); // Model / effort
    if (o.model != null) {
      await term.press(KEY.right);
      for (let i = 0; i < o.model; i++) await term.press(KEY.down);
      await term.press(KEY.enter);
    }
    if (o.effort != null) {
      await term.press(KEY.down);
      await term.press(KEY.right);
      for (let i = 0; i < o.effort; i++) await term.press(KEY.down);
      await term.press(KEY.enter);
    }
    await term.press(KEY.left); // back to the groups
  }
  if (o.labels != null) {
    await term.press(KEY.down);
    await term.press(KEY.down);
    await term.press(KEY.right); // Other
    await term.press(KEY.down);
    await term.press(KEY.down);
    await term.press(KEY.right);
    await term.press(o.labels);
    await term.press(KEY.enter);
    await term.press(KEY.left);
  }
  await term.press(KEY.left); // back to the form
}

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
    await setTags(term, { model: 1, effort: 3, labels: 'docs' });
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
    expect(t.status).toBe('backlog');
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
    await setTags(term, { labels: 'effort=turbo' });
    await term.press(KEY.enter);
    const f = await term.waitFor((s) => s.includes('effort must be one of'), 'error');
    expect(f).toContain('new ticket');
    expect(listTickets(db).some((t) => t.name === 'Bad tags')).toBe(false);
    await term.press(KEY.tab);
    await term.press('x');
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

describe('command line', () => {
  const type = async (term: ReturnType<typeof fakeTerminal>, text: string) => {
    for (const ch of text) await term.press(ch, 5);
  };

  test(': focuses the prompt; a command runs through the CLI handlers and the list refreshes', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('ticket 001'));
    await term.press(':');
    await type(term, 'salu add "from prompt" "do it" model=sonnet');
    await term.press(KEY.enter, 200);
    const f = await term.waitFor((s) => s.includes('from prompt'), 'new ticket in list');
    expect(f).toContain('from prompt');
    expect(listTickets(db).some((t) => t.name === 'from prompt')).toBe(true);
  });

  test('the leading salu is optional and errors show in the footer', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('ticket 001'));
    await term.press(':');
    await type(term, 'remove "ticket 001"');
    await term.press(KEY.enter, 200);
    const f = await term.waitFor((s) => s.includes('--yes'), 'needs --yes');
    expect(f).toContain('ticket 001');
    expect(listTickets(db).some((t) => t.name === 'ticket 001')).toBe(true);
  });

  test('multi-line output opens a result view; esc returns to the list', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db }, [100, 40]);
    await term.waitFor((s) => s.includes('ticket 001'));
    await term.press(':');
    await type(term, '?');
    await term.press(KEY.enter, 200);
    const f = await term.waitFor((s) => s.includes('output') && s.includes('a fast ticket queue'), 'help output');
    expect(f).toContain('salu add project');
    await term.press(KEY.esc);
    await term.waitFor((s) => s.includes('ticket 001') && !s.includes('a fast ticket queue'));
  });

  test('up recalls history and esc leaves the prompt; single keys work again', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('ticket 001'));
    await term.press(':');
    await type(term, 'pause');
    await term.press(KEY.enter, 200);
    await term.press(KEY.up);
    expect(term.lastFrame()).toContain('❯ pause');
    await term.press(KEY.esc);
    await term.press('?');
    await term.waitFor((s) => s.includes('any key closes help'));
  });

  test('tab completes verbs and project names', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('ticket 001'));
    await term.press(':');
    await type(term, 'rem');
    await term.press(KEY.tab);
    expect(term.lastFrame()).toContain('❯ remove');
  });
});

describe('easter eggs on the command line', () => {
  const type = async (term: ReturnType<typeof fakeTerminal>, text: string) => {
    for (const ch of text) await term.press(ch, 5);
  };
  const KANA = /[\uff66-\uff9d]/;

  test('matrix: rain fills the screen, then the same view is back with the prompt focused and no history', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db }, [100, 24]);
    await term.waitFor((s) => s.includes('ticket 001'));
    await term.press(':');
    await type(term, 'matrix');
    await term.press(KEY.enter, 20);
    const rain = await term.waitFor((s) => KANA.test(s) && !s.includes('ticket 001'), 'rain');
    expect(rain.split('\n').length).toBeGreaterThanOrEqual(20);
    const back = await term.waitFor((s) => s.includes('ticket 001') && !KANA.test(s), 'list again', 3500);
    expect(back).toContain('⏎ run'); // command line still focused
    expect(back).not.toContain('matrix');
    expect(back).not.toContain('unknown command');
    await term.press(KEY.up); // nothing to recall
    expect(term.lastFrame()).not.toContain('matrix');
  }, 10_000);

  test('any key ends the rain at once', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('ticket 001'));
    await term.press(':');
    await type(term, 'salu MATRIX');
    await term.press(KEY.enter, 20);
    await term.waitFor((s) => KANA.test(s), 'rain');
    await term.press('x', 80);
    expect(term.lastFrame()).toContain('ticket 001');
    expect(term.lastFrame()).not.toContain('❯ x'); // the key was eaten by the rain
  });

  test('dojjan: the sleeping dog barks twice and dozes off; eskil yawns', async () => {
    const { db } = seedDb(0);
    const { term } = mountApp({ db }, [130, 34]);
    await term.waitFor((s) => s.includes('no tickets running'));
    await term.press(':');
    await type(term, 'dojjan');
    const woofs: number[] = [];
    let seen = false;
    const t0 = Date.now();
    await term.press(KEY.enter, 0);
    while (Date.now() - t0 < 3000) {
      const has = term.lastFrame().includes('WOOF!');
      if (has && !seen) woofs.push(Date.now() - t0);
      seen = has;
      await sleep(20);
    }
    expect(woofs).toHaveLength(2);
    expect(term.lastFrame()).not.toContain('WOOF!');
    expect(term.lastFrame()).toContain('no tickets running');
    await type(term, 'eskil');
    await term.press(KEY.enter, 0);
    await term.waitFor((s) => s.includes('yaaawn'), 'yawn');
    await term.waitFor((s) => !s.includes('yaaawn'), 'asleep again', 3000);
    expect(term.lastFrame()).not.toContain('unknown command');
  }, 12_000);

  test('without the activity area the dog answers in the footer', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db }, [100, 24]);
    await term.waitFor((s) => s.includes('ticket 001'));
    await term.press(':');
    await type(term, 'dojjan');
    await term.press(KEY.enter, 80);
    expect(term.lastFrame()).toContain('WOOF! WOOF!');
  });
});

describe('two panes: project tree and tickets', () => {
  function seedTree() {
    const { db, home } = seedDb(0);
    const web = listProjects(db).find((p) => p.name === 'web')!;
    const ui = createProject(db, { name: 'web-ui', path: join(home, 'web', 'ui'), parentId: web.id });
    const forms = createProject(db, { name: 'forms', path: join(home, 'web', 'ui', 'forms'), parentId: ui.id });
    const mk = (project_id: number, name: string) => createTicket(db, { project_id, name, query: name, tags: {}, labels: [], priority: 3 });
    mk(web.id, 'web root job');
    mk(ui.id, 'ui job');
    mk(forms.id, 'forms job');
    return { db, web, ui, forms };
  }

  test('wide terminals show the tree beside the tickets; a project lists its whole subtree', async () => {
    const { db } = seedTree();
    const { term } = mountApp({ db }, [130, 30]);
    let f = await term.waitFor((s) => s.includes('all projects') && s.includes('web root job'), 'tree and tickets');
    expect(f).toContain('▸');
    await term.press(KEY.down); // web
    f = term.lastFrame();
    expect(f).toContain('web root job');
    expect(f).toContain('ui job');
    expect(f).toContain('forms job');
    await term.press(KEY.right); // open web
    f = term.lastFrame();
    expect(f).toContain('web-ui');
    await term.press(KEY.down); // web-ui
    f = term.lastFrame();
    expect(f).not.toContain('web root job');
    expect(f).toContain('ui job');
    expect(f).toContain('forms job');
    await term.press(KEY.right); // open web-ui
    await term.press(KEY.down); // forms
    f = term.lastFrame();
    expect(f).not.toContain('ui job');
    expect(f).toContain('forms job');
    expect(f).toContain('▌salu › web › web-ui › forms');
  });

  test('left goes back up; right on a leaf and tab move focus to the tickets', async () => {
    const { db } = seedTree();
    const { term } = mountApp({ db }, [130, 30]);
    await term.waitFor((s) => s.includes('web root job'));
    await term.press(KEY.down);
    await term.press(KEY.right);
    await term.press(KEY.down);
    await term.press(KEY.left); // web-ui is closed, so back to web
    expect(term.lastFrame()).toContain('▌salu › web');
    expect(term.lastFrame()).not.toContain('▌salu › web › web-ui');
    await term.press(KEY.tab);
    expect(term.lastFrame()).toContain('open'); // list hints, not tree hints
    await term.press(KEY.left); // back to the tree
    expect(term.lastFrame()).toContain('add project');
  });

  test('the pane with the focus is marked: heavy border and ▌ title, readable without colour', async () => {
    const { db } = seedTree();
    const { term } = mountApp({ db }, [130, 30]);
    let f = await term.waitFor((s) => s.includes('web root job'));
    expect(f).toContain('┏━ ▌projects');
    expect(f).toContain('╭─ tickets');
    expect(f).toContain('tab switch pane');
    await term.press(KEY.tab); // tickets
    f = term.lastFrame();
    expect(f).toContain('╭─ projects');
    expect(f).toContain('┏━ ▌tickets');
    expect(f).toContain('tab switch pane');
    expect(f.match(/▌/g)!.length).toBe(2); // wordmark + the active pane's title
    await term.press(KEY.tab); // command line: both panes go quiet, the prompt gets the heavy box
    f = term.lastFrame();
    expect(f).toContain('╭─ projects');
    expect(f).toContain('╭─ tickets');
    expect(f).toContain('┃ ▌❯');
    expect(f).toContain('esc back to the lists');
    await term.press(KEY.tab); // round again to the tree
    expect(term.lastFrame()).toContain('┏━ ▌projects');
    expect(term.lastFrame()).not.toContain('┃ ▌❯');
    await term.press(KEY.tab);
    await term.press(KEY.left); // arrows never move between windows
    expect(term.lastFrame()).toContain('┏━ ▌tickets');
    await term.press(KEY.shiftTab); // reverse: tickets -> tree -> command line -> tickets
    expect(term.lastFrame()).toContain('┏━ ▌projects');
    await term.press(KEY.right); // on a leaf-or-open row, right stays in the tree
    expect(term.lastFrame()).toContain('┏━ ▌projects');
    await term.press(KEY.shiftTab);
    expect(term.lastFrame()).toContain('┃ ▌❯');
    await term.press(KEY.shiftTab);
    expect(term.lastFrame()).toContain('┏━ ▌tickets');
  });

  test('narrow terminals fall back to a single pane', async () => {
    const { db } = seedTree();
    const { term } = mountApp({ db }, [90, 30]);
    const f = await term.waitFor((s) => s.includes('web root job'));
    expect(f).not.toContain(' │ ');
    expect(f).not.toContain('▸');
  });

  test('a adds a project through the command line, d removes the selected one after y', async () => {
    const { db } = seedTree();
    const { term } = mountApp({ db }, [130, 30]);
    await term.waitFor((s) => s.includes('web root job'));
    await term.press('a');
    for (const ch of 'newproj') await term.press(ch, 5);
    await term.press(KEY.enter, 300);
    await term.waitFor((s) => /[▸ ] newproj\s+\d*\s*[│┃]/.test(s) || s.includes('added') || s.includes('project newproj'), 'command ran');
    for (let i = 0; i < 50 && !listProjects(db).some((p) => p.name === 'newproj'); i++) await sleep(20);
    expect(listProjects(db).some((p) => p.name === 'newproj')).toBe(true);
    await term.waitFor((s) => /newproj\s+\d*\s*[│┃]/.test(s), 'project in tree');
    await term.press(KEY.esc);
    await term.press(KEY.down);
    await term.press(KEY.down);
    await term.press(KEY.down); // web, api, newproj
    await term.press('d');
    expect(term.lastFrame()).toContain('remove project "newproj"');
    await term.press('y', 300);
    await term.waitFor((s) => !s.includes('newproj'), 'project gone');
    expect(listProjects(db).some((p) => p.name === 'newproj')).toBe(false);
  });

  test('the braille dog runs in the header while something is running', async () => {
    const { db } = seedDb(6); // ticket 001 is running
    const { term } = mountApp({ db }, [130, 30]);
    const f = await term.waitFor((s) => /[\u2801-\u28ff]/.test(s.split('\n')[0] ?? ''), 'dog in header');
    expect(f.split('\n')[0]).toMatch(/[\u2801-\u28ff]{4}/);
  });
});

describe('three windows and the live activity area', () => {
  function withLog(db: any, home: string, ticketId: number, lines: object[], name = 'w.jsonl') {
    mkdirSync(join(home, 'logs'), { recursive: true });
    const path = join(home, 'logs', name);
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    createRun(db, ticketId, path);
    return path;
  }
  const say = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const tool = (name: string, file: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: { file_path: file } }] } });

  test('tab reaches the command line, plain typing goes straight in, esc returns to the last pane', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db }, [130, 32]);
    await term.waitFor((s) => s.includes('ticket 001'));
    await term.press(KEY.tab); // tickets
    await term.press(KEY.tab); // command line
    for (const ch of 'add "typed straight in"') await term.press(ch, 5);
    expect(term.lastFrame()).toContain('add "typed straight in"');
    await term.press(KEY.esc);
    expect(term.lastFrame()).toContain('┏━ ▌tickets'); // back where it came from
    expect(term.lastFrame()).not.toContain('typed straight in');
  });

  test('the activity area streams the running ticket, follows the selection, and pins', async () => {
    const { db, home, ids } = seedDb(6); // ticket 001 (ids[0]) runs, 007 would too but only 6 here
    const running = listTickets(db).filter((t) => t.status === 'running');
    expect(running.length).toBe(1);
    withLog(db, home, ids[0]!, [{ type: 'ticket_start', options: { model: 'claude-opus-5-5' } }, say('Looking at the auth middleware'), tool('Read', 'src/auth.ts'), tool('Edit', 'src/auth.ts')]);
    const { term } = mountApp({ db }, [130, 34]);
    let f = await term.waitFor((s) => s.includes('Read(src/auth.ts)'), 'worker output');
    expect(f).toContain('activity · ticket 001');
    expect(f).toContain('Looking at the auth middleware');
    expect(f).toContain('Edit(src/auth.ts)');
    expect(f).toContain('f pin');
    await term.press(KEY.tab); // tickets pane: selection is the running ticket
    await term.press('f');
    f = term.lastFrame();
    expect(f).toContain('(pinned)');
    expect(f).toContain('f unpin');
    await term.press('f');
    expect(term.lastFrame()).not.toContain('(pinned)');
  });

  test('[ and ] scroll the activity back and forward', async () => {
    const { db, home, ids } = seedDb(6);
    const many = Array.from({ length: 40 }, (_, i) => say(`step number ${i + 1}`));
    withLog(db, home, ids[0]!, many);
    const { term } = mountApp({ db }, [130, 34]);
    let f = await term.waitFor((s) => s.includes('step number 40'), 'newest step');
    expect(f).not.toContain('step number 20');
    for (let i = 0; i < 4; i++) await term.press('[');
    f = term.lastFrame();
    expect(f).toContain('↑');
    expect(f).not.toContain('step number 40');
    for (let i = 0; i < 6; i++) await term.press(']');
    expect(term.lastFrame()).toContain('step number 40');
  });

  test('nothing running: a calm sleeping-dog empty state', async () => {
    const { db } = seedDb(0);
    const { term } = mountApp({ db }, [130, 34]);
    const f = await term.waitFor((s) => s.includes('no tickets running'), 'empty state');
    expect(f).toContain('activity');
  });

  test('short terminals drop the activity area; narrow ones stack the panes', async () => {
    const { db } = seedDb(6);
    const short = mountApp({ db }, [130, 24]);
    let f = await short.term.waitFor((s) => s.includes('ticket 001'));
    expect(f).not.toContain('activity');
    expect(f).toContain('┏━ ▌projects');
    const narrow = mountApp({ db }, [90, 34]);
    f = await narrow.term.waitFor((s) => s.includes('ticket 001'));
    expect(f).toContain('activity');
    expect(f).toContain('┏━ ▌tickets');
    expect(f).not.toContain('projects ─');
  });
});

describe('ticket properties (right arrow on a ticket)', () => {
  const rowsDown = async (term: any, n: number) => {
    for (let i = 0; i < n; i++) await term.press(KEY.down);
  };
  const poll = async (fn: () => boolean, what: string) => {
    for (let i = 0; i < 60 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
    if (!fn()) throw new Error('timed out: ' + what);
  };

  test('right opens every property, left closes; arrows never leave through the sides', async () => {
    const { db } = seedDb(12);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('ticket 001'));
    await term.press(KEY.right);
    const f = await term.waitFor((s) => s.includes('properties'), 'props');
    for (const w of ['name', 'query', 'project', 'status', 'model', 'effort', 'toolset', 'priority', 'permission', 'max-turns', 'created', 'last run']) expect(f).toContain(w);
    expect(f).toContain('opus');
    expect(f).toContain('standard');
    await term.press(KEY.left);
    await term.waitFor((s) => !s.includes('properties') && s.includes('ticket 001'), 'back to list');
  });

  test('a text property is edited in place and saved through salu change', async () => {
    const { db, ids } = seedDb(12);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('ticket 001'));
    await term.press(KEY.right);
    await term.waitFor((s) => s.includes('properties'));
    await term.press(KEY.right); // edit the name
    await term.press(' renamed');
    await term.press(KEY.enter);
    await poll(() => getTicketById(db, ids[0]!)!.name === 'ticket 001 renamed', 'rename');
  });

  test('pick-lists change model and tools without losing the other tags', async () => {
    const { db, ids } = seedDb(12);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('ticket 001'));
    await term.press(KEY.right);
    await term.waitFor((s) => s.includes('properties'));
    await rowsDown(term, 4); // model
    await term.press(KEY.right);
    await term.waitFor((s) => s.includes('sonnet'), 'model choices');
    await term.press(KEY.down); // opus -> sonnet
    await term.press(KEY.enter);
    await poll(() => JSON.parse(getTicketById(db, ids[0]!)!.tags).model === 'sonnet', 'model saved');
    let t = getTicketById(db, ids[0]!)!;
    expect(JSON.parse(t.tags).effort).toBe('high');
    expect(JSON.parse(t.labels)).toEqual(['bug']);
    await rowsDown(term, 2); // toolset
    await term.press(KEY.right);
    await term.waitFor((s) => s.includes('readonly'), 'toolset choices');
    await term.press(KEY.down);
    await term.press(KEY.enter);
    await poll(() => JSON.parse(getTicketById(db, ids[0]!)!.tags).tools === 'readonly', 'tools saved');
    t = getTicketById(db, ids[0]!)!;
    expect(JSON.parse(t.tags).model).toBe('sonnet');
  });

  test('status and priority are pick-lists too; a bad value is reported and nothing is saved', async () => {
    const { db, ids } = seedDb(12);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('ticket 001'));
    await term.press(KEY.right);
    await term.waitFor((s) => s.includes('properties'));
    await rowsDown(term, 3); // status (running -> done is the next choice)
    await term.press(KEY.right);
    await term.press(KEY.down);
    await term.press(KEY.enter);
    await poll(() => getTicketById(db, ids[0]!)!.status === 'done', 'status saved');
    await rowsDown(term, 6); // max-turns text row
    await term.press(KEY.right);
    await term.press('abc');
    await term.press(KEY.enter);
    await term.waitFor((s) => s.includes('max-turns must be'), 'error');
    expect(JSON.parse(getTicketById(db, ids[0]!)!.tags)['max-turns']).toBeUndefined();
  });
});

describe('tag groups in the form', () => {
  test('the groups are Model / effort, Tools and Other; tools defaults to standard', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/3'));
    await term.press('a');
    await term.press(KEY.tab);
    await term.press(KEY.tab);
    await term.press(KEY.right);
    let f = await term.waitFor((s) => s.includes('Model / effort'), 'groups');
    expect(f).toContain('Tools');
    expect(f).toContain('Other');
    expect(f).toContain('standard');
    await term.press(KEY.down);
    await term.press(KEY.right);
    f = await term.waitFor((s) => s.includes('toolset'), 'tools group');
    await term.press(KEY.right);
    f = await term.waitFor((s) => s.includes("Claude Code's regular tools"), 'toolset choices');
    expect(f).toContain('readonly');
    expect(f).toContain('custom');
  });

  test('custom tools build one tools= value; a bad rule is refused with the core message', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/3'));
    await term.press('a');
    await term.press('Custom tools');
    await term.press(KEY.tab);
    await term.press('q');
    await term.press(KEY.tab);
    await term.press(KEY.right);
    await term.press(KEY.down);
    await term.press(KEY.right); // Tools
    await term.press(KEY.right); // toolset pick
    for (let i = 0; i < 4; i++) await term.press(KEY.down); // standard, readonly, edit, none, custom
    await term.press(KEY.enter);
    await term.waitFor((s) => s.includes('allow') && s.includes('deny'), 'allow and deny rows');
    await term.press(KEY.down);
    await term.press(KEY.right);
    await term.press('read');
    await term.press(KEY.enter);
    await term.waitFor((s) => s.includes('case sensitive'), 'core error');
    for (let i = 0; i < 4; i++) await term.press(KEY.backspace);
    await term.press('Read,Grep');
    await term.press(KEY.enter);
    await term.press(KEY.down);
    await term.press(KEY.right);
    await term.press('Bash(rm *)');
    await term.press(KEY.enter);
    await term.press(KEY.left);
    await term.press(KEY.left);
    await term.press(KEY.enter);
    await term.waitFor((s) => s.includes('added "Custom tools"'), 'added');
    const t = listTickets(db).find((x) => x.name === 'Custom tools')!;
    expect(JSON.parse(t.tags).tools).toBe('allow:Read,Grep;deny:Bash(rm *)');
    expect(JSON.parse(t.tags)['deny-tools']).toBeUndefined();
  });

  test('tools chosen in the form end up in the ticket tags', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/3'));
    await term.press('a');
    await term.press('Tooled');
    await term.press(KEY.tab);
    await term.press('q');
    await term.press(KEY.tab);
    await term.press(KEY.right);
    await term.press(KEY.down);
    await term.press(KEY.right); // Tools
    await term.press(KEY.right); // toolset pick
    await term.press(KEY.down);
    await term.press(KEY.enter); // read-only
    await term.press(KEY.left);
    await term.press(KEY.left);
    await term.press(KEY.enter);
    await term.waitFor((s) => s.includes('added "Tooled"'), 'added');
    expect(JSON.parse(listTickets(db).find((x) => x.name === 'Tooled')!.tags).tools).toBe('readonly');
  });
});

describe('ticket output (right arrow on a finished ticket)', () => {
  const writeLog = (home: string, name: string, answer: string) => {
    mkdirSync(join(home, 'logs'), { recursive: true });
    const path = join(home, 'logs', name);
    const msg = (content: object[]) => ({ type: 'assistant', message: { content } });
    writeFileSync(
      path,
      [
        { type: 'ticket_start', options: { model: 'claude-opus-5-5', effort: 'high' } },
        msg([{ type: 'tool_use', name: 'Read', input: { file_path: 'src/auth.ts' } }]),
        msg([{ type: 'text', text: answer }]),
        { type: 'result', subtype: 'success', num_turns: 4, total_cost_usd: 0.12, result: answer },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    );
    return path;
  };

  test('a done ticket opens on its output: result first, then the transcript', async () => {
    const { db, home, ids } = seedDb(12);
    createRun(db, ids[3]!, writeLog(home, 'a.jsonl', 'Fixed the null check in auth'));
    const { term } = mountApp({ db, statuses: ['done'] });
    await term.waitFor((s) => s.includes('ticket 004'));
    await term.press(KEY.right);
    const f = await term.waitFor((s) => s.includes('transcript'), 'output');
    expect(f).toContain('output');
    expect(f).toContain('result');
    expect(f).toContain('Fixed the null check in auth');
    expect(f).toContain('Read(src/auth.ts)');
    expect(f).toContain('4 turns');
    expect(f).toContain('p properties');
    await term.press('p');
    await term.waitFor((s) => s.includes('properties') && s.includes('toolset'), 'properties');
    await term.press('o');
    await term.waitFor((s) => s.includes('transcript'), 'output again');
    await term.press(KEY.left);
    await term.waitFor((s) => s.includes('properties'), 'left goes to properties');
  });

  test('a failed ticket shows its error first; [ ] step through earlier runs', async () => {
    const { db, home, ids } = seedDb(12);
    createRun(db, ids[10]!, writeLog(home, 'old.jsonl', 'first attempt answer'));
    await new Promise((r) => setTimeout(r, 5));
    createRun(db, ids[10]!, writeLog(home, 'new.jsonl', 'second attempt answer'));
    updateTicket(db, ids[10]!, { error: 'the build broke: missing dependency' });
    const { term } = mountApp({ db, statuses: ['failed'] });
    await term.waitFor((s) => s.includes('ticket 011'));
    await term.press(KEY.right);
    let f = await term.waitFor((s) => s.includes('transcript'), 'output');
    expect(f).toContain('the build broke: missing dependency');
    expect(f).toContain('second attempt answer');
    expect(f).toContain('run 2 of 2');
    await term.press('[');
    f = await term.waitFor((s) => s.includes('run 1 of 2'), 'older run');
    expect(f).toContain('first attempt answer');
    expect(f).not.toContain('the build broke');
    await term.press(']');
    await term.waitFor((s) => s.includes('run 2 of 2'), 'newer run');
  });

  test('a long transcript scrolls; a ticket that never ran shows the properties', async () => {
    const { db, home, ids } = seedDb(12);
    mkdirSync(join(home, 'logs'), { recursive: true });
    const path = join(home, 'logs', 'long.jsonl');
    const many = Array.from({ length: 200 }, (_, i) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `file-${i}.ts` } }] } }));
    writeFileSync(path, many.join('\n') + '\n');
    createRun(db, ids[3]!, path);
    const { term } = mountApp({ db, statuses: ['done'] }, [100, 24]);
    await term.waitFor((s) => s.includes('ticket 004'));
    await term.press(KEY.right);
    let f = await term.waitFor((s) => s.includes('file-0.ts'), 'top');
    expect(f).not.toContain('file-199.ts');
    await term.press('G');
    f = await term.waitFor((s) => s.includes('file-199.ts'), 'bottom');
    expect(f).not.toContain('file-0.ts');
    await term.press(KEY.left);
    await term.press(KEY.left);
    await term.waitFor((s) => s.includes('ticket 010'), 'back to the list');
    await term.press(KEY.down);
    await term.press(KEY.right); // ticket 010 never ran: properties, not output
    const g = await term.waitFor((s) => s.includes('toolset'), 'properties');
    expect(g).not.toContain('transcript');
  });
});

describe('usage meter in the header', () => {
  const win = (used: number) => ({ id: 'session', short: '5h', label: '5-hour', percentUsed: used, percentLeft: 100 - used, utilization: used / 100, status: 'allowed', resetsAt: Date.now() + 3_600_000, observedAt: Date.now(), source: 'usage' });
  const wrap = (windows: any[]) => ({ available: true, reason: null, reasonKind: null, plan: 'max', windows, updatedAt: Date.now(), fetchedAt: Date.now(), stale: false, error: null });
  const source = (first: any) => {
    let cb: ((s: any) => void) | null = null;
    return {
      get: () => first,
      subscribe: (f: (s: any) => void) => {
        cb = f;
        return () => {
          cb = null;
        };
      },
      push: (s: any) => cb?.(s),
    };
  };

  test('shows what is left, follows the data layer, and is absent without a source', async () => {
    const { db } = seedDb(6);
    const src = source(wrap([win(62)]));
    const { term } = mountApp({ db, usage: src }, [130, 34]);
    let f = await term.waitFor((s) => s.includes('5h '), 'meter');
    expect(f).toContain('38% left');
    src.push(wrap([win(90)]));
    f = await term.waitFor((s) => s.includes('10% left'), 'updated');
    src.push(null);
    await term.waitFor((s) => s.includes('usage n/a'), 'n/a');
    const { term: t2 } = mountApp({ db }, [130, 34]);
    const g = await t2.waitFor((s) => s.includes('ticket 001'));
    expect(g).not.toContain('usage');
    expect(g).not.toContain('5h ');
  });

  test('on a narrow terminal it collapses and the counts stay', async () => {
    const { db } = seedDb(6);
    const src = source(wrap([win(62)]));
    const { term } = mountApp({ db, usage: src }, [90, 24]);
    const f = await term.waitFor((s) => s.includes('ticket 001'));
    const head = f.split('\n')[0]!;
    expect(head).toContain('38%');
    expect(head).not.toContain('resets');
    expect(head).toContain('running');
  });
});

describe('backlog and queue', () => {
  const addTicket = async (term: any, name: string, queue: boolean) => {
    await term.press('a');
    await term.press(name);
    await term.press(KEY.tab);
    await term.press('do it');
    for (let i = 0; i < 3; i++) await term.press(KEY.tab); // tags, priority, then
    if (queue) await term.press(KEY.right);
    await term.press(KEY.enter);
  };

  test('a new ticket is saved to the backlog by default and says how to queue it', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/3'));
    await term.press('a');
    const f = await term.waitFor((s) => s.includes('save only'), 'queue row');
    expect(f).toContain('backlog');
    await term.press(KEY.esc);
    await addTicket(term, 'Saved only', false);
    const m = await term.waitFor((s) => s.includes('to the backlog'), 'added message');
    expect(m).toContain('u queues it');
    expect(listTickets(db).find((t) => t.name === 'Saved only')!.status).toBe('backlog');
  });

  test('"save and queue" makes the ticket eligible to run at once', async () => {
    const { db } = seedDb(3);
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('1/3'));
    await addTicket(term, 'Queued now', true);
    await term.waitFor((s) => s.includes('and queued it'), 'added and queued');
    expect(listTickets(db).find((t) => t.name === 'Queued now')!.status).toBe('todo');
  });

  test('u queues a backlog ticket and takes a queued one back; a running one is refused', async () => {
    const { db, ids } = seedDb(12);
    updateTicket(db, ids[1]!, { status: 'backlog' });
    const { term } = mountApp({ db });
    await term.waitFor((s) => s.includes('ticket 002'));
    await term.press('/');
    await term.press('ticket 002');
    await term.press(KEY.enter);
    await term.press('u');
    await term.waitFor((s) => s.includes('queued'), 'queued');
    expect(getTicketById(db, ids[1]!)!.status).toBe('todo');
    await term.press('u');
    await term.waitFor((s) => s.includes('back in the backlog'), 'unqueued');
    expect(getTicketById(db, ids[1]!)!.status).toBe('backlog');
    await term.press(KEY.esc); // clear the filter
    await term.press('/');
    await term.press('ticket 001');
    await term.press(KEY.enter);
    await term.press('u');
    await term.waitFor((s) => s.includes("can't be queued"), 'running refused');
    expect(getTicketById(db, ids[0]!)!.status).toBe('running');
  });

  test('the header counts show the backlog', async () => {
    const { db, ids } = seedDb(12);
    updateTicket(db, ids[1]!, { status: 'backlog' });
    const { term } = mountApp({ db }, [130, 34]);
    const f = await term.waitFor((s) => s.includes('backlog'), 'count');
    expect(f.split('\n')[0]).toContain('1 backlog');
  });
});
