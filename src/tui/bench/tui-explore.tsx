import React from 'react';
import { render } from 'ink';
import { fakeTerminal, seedDb, KEY, sleep } from '../../../test/tui/harness.ts';
import { App } from '../app.tsx';
import { defaultActions } from '../actions.ts';

const { db } = seedDb(12);
const term = fakeTerminal(100, 20);
const t0 = performance.now();
const inst = render(<App db={db} projectId={null} actions={defaultActions(db)} pollMs={200} />, {
  stdout: term.stdout,
  stdin: term.stdin,
  debug: true,
  patchConsole: false,
});
await inst.waitUntilRenderFlush();
console.error('first frame ms', (performance.now() - t0).toFixed(1));
const show = (label: string) => { console.log(`===== ${label} =====`); console.log(term.lastFrame()); };
show('initial');
await term.press(KEY.down); await term.press(KEY.down); show('down x2');
await term.press('/'); await term.press('bug'); show('filter bug');
await term.press(KEY.enter); show('filter done');
await term.press(KEY.enter); show('detail');
await term.press(KEY.esc); await term.press(KEY.esc); show('after esc esc (filter cleared)');
await term.press(KEY.tab); show('tab -> web');
await term.press('a'); await term.press('New one'); await term.press(KEY.tab); await term.press('do it'); await term.press(KEY.tab); await term.press('model=opus bug'); show('form');
await term.press(KEY.enter); await sleep(50); show('after save');
await term.press('d'); show('confirm');
await term.press('y'); await sleep(50); show('deleted');
await term.press('?'); show('help');
await term.press('q'); await term.press('q'); await sleep(50);
inst.unmount();
await inst.waitUntilExit();
console.error('frames', term.frames.length);
