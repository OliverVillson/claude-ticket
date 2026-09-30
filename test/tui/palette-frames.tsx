// Child process for palette.test.ts: renders the main screens with colour forced on and prints every frame.
import React from 'react';
import { render } from 'ink';
import { App } from '../../src/tui/app.tsx';
import { defaultActions } from '../../src/tui/actions.ts';
import { KEY, fakeTerminal, seedDb } from './harness.ts';

const { db } = seedDb(12);
const frames: string[] = [];

async function run(width: number, steps: string[]) {
  const term = fakeTerminal(width, 30);
  const inst = render(<App db={db} projectId={null} actions={defaultActions(db)} pollMs={100} />, { stdout: term.stdout, stdin: term.stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
  await term.waitFor((s) => s.includes('ticket 001'));
  for (const k of steps) await term.press(k, 80);
  inst.unmount();
  frames.push(...term.frames);
}

// One pane (narrow): list, help, filter, delete confirm, detail, add form, command line.
await run(100, ['?', 'x', '/', 'zz', KEY.enter, KEY.esc, 'd', 'n', KEY.enter, 'x', KEY.esc, 'a', 'ab', KEY.tab, KEY.tab, KEY.esc, ':', 'sta', KEY.tab, KEY.enter, KEY.esc, KEY.esc]);
// Two panes (wide): project tree focused, move, open, tab to tickets, back with left, remove confirm.
await run(130, [KEY.down, KEY.right, KEY.down, KEY.left, KEY.tab, KEY.down, KEY.left, 'd', 'n', 'a', KEY.esc, KEY.esc]);
// Flush before exiting: process.exit() right after console.log truncates a large payload on a pipe.
process.stdout.write(JSON.stringify(frames) + '\n', () => process.exit(0));
