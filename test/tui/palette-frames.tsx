// Child process for palette.test.ts: renders the main screens with colour forced on and prints every frame.
import React from 'react';
import { render } from 'ink';
import { App } from '../../src/tui/app.tsx';
import { defaultActions } from '../../src/tui/actions.ts';
import { KEY, fakeTerminal, seedDb, sleep } from './harness.ts';

const { db } = seedDb(12);
const term = fakeTerminal(110, 30);
const inst = render(<App db={db} projectId={null} actions={defaultActions(db)} pollMs={100} />, { stdout: term.stdout, stdin: term.stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
await term.waitFor((s) => s.includes('ticket 001'));
const steps: string[] = ['?', 'x', '/', 'zz', KEY.enter, KEY.esc, 'd', 'n', KEY.enter, 'x', KEY.esc, 'a', 'ab', KEY.tab, KEY.tab, KEY.esc, ':', 'sta', KEY.tab, KEY.enter, KEY.esc, KEY.esc];
for (const k of steps) await term.press(k, 80);
inst.unmount();
console.log(JSON.stringify(term.frames));
process.exit(0);
