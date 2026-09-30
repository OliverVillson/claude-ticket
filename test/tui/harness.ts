import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/db.ts';
import { createProject, createTicket, updateTicket } from '../../src/db/queries.ts';
import type { TicketStatus } from '../../src/db/types.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

export const KEY = {
  up: '\u001b[A',
  down: '\u001b[B',
  left: '\u001b[D',
  right: '\u001b[C',
  enter: '\r',
  esc: '\u001b',
  tab: '\t',
  shiftTab: '\u001b[Z',
  backspace: '\u007f',
  pageDown: '\u001b[6~',
  pageUp: '\u001b[5~',
  home: '\u001b[H',
  end: '\u001b[F',
  ctrlC: '\u0003',
};

/** Fake terminal streams for driving an Ink app: frames are captured (Ink runs in debug mode). */
export function fakeTerminal(columns = 100, rows = 30) {
  const stdin = new PassThrough() as any;
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const frames: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      frames.push(chunk.toString());
      cb();
    },
  }) as any;
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.rows = rows;
  const term = {
    stdin,
    stdout,
    frames,
    /** the most recent frame with ANSI codes removed */
    lastFrame: () => stripAnsi(frames[frames.length - 1] ?? ''),
    /** send keys, then give React a moment to render */
    press: async (keys: string, wait = 50) => {
      stdin.write(keys);
      await sleep(wait);
    },
    /** poll until the last frame satisfies `test`; throws with the frame on timeout */
    waitFor: async (test: (frame: string) => boolean, what = 'condition', timeout = 3000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (test(term.lastFrame())) return term.lastFrame();
        await sleep(20);
      }
      throw new Error(`timed out waiting for ${what}. Last frame:\n${term.lastFrame()}`);
    },
  };
  return term;
}

/**
 * A throwaway database with two projects and `n` tickets in mixed statuses. Sets TICKET_HOME so
 * `wakeOrchestrator()` and log paths never touch the real ~/.ticket.
 */
export function seedDb(n = 12) {
  const home = mkdtempSync(join(tmpdir(), 'ticket-tui-test-'));
  process.env.TICKET_HOME = home;
  const db = openDb(join(home, 'tickets.db'));
  const web = createProject(db, { name: 'web', path: join(home, 'web') });
  const api = createProject(db, { name: 'api', path: join(home, 'api') });
  const statuses: TicketStatus[] = ['running', 'todo', 'todo', 'done', 'failed', 'blocked'];
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = createTicket(db, {
      project_id: i % 2 ? api.id : web.id,
      name: `ticket ${String(i + 1).padStart(3, '0')}`,
      query: `do thing number ${i + 1}`,
      tags: i % 3 === 0 ? { model: 'opus', effort: 'high' } : {},
      labels: i % 4 === 0 ? ['bug'] : [],
      priority: (i % 5) + 1,
    });
    updateTicket(db, t.id, { status: statuses[i % statuses.length]! });
    ids.push(t.id);
  }
  return { db, home, web, api, ids };
}
