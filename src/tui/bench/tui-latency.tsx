// In-process key latency: bun run src/tui/bench/tui-latency.tsx [n] [maxFps] [incremental]
import React from 'react';
import { render } from 'ink';
import { fakeTerminal, seedDb, KEY, sleep } from '../../../test/tui/harness.ts';
import { App } from '../app.tsx';
import { defaultActions } from '../actions.ts';

const n = Number(process.argv[2] ?? 500);
const maxFps = Number(process.argv[3] ?? 30);
const incremental = process.argv[4] === 'inc';
const { db } = seedDb(n);
const term = fakeTerminal(120, 40);
const inst = render(<App db={db} projectId={null} actions={defaultActions(db)} pollMs={1000} />, {
  stdout: term.stdout, stdin: term.stdin, debug: !incremental, patchConsole: false, exitOnCtrlC: false, maxFps, incrementalRendering: incremental,
});
await term.waitFor((s) => s.includes(`1/${n}`), 'first frame');
await sleep(200);
const times: number[] = [];
for (let i = 1; i <= 40; i++) {
  const want = `${i + 1}/${n}`;
  const t0 = performance.now();
  term.stdin.write(KEY.down);
  while (!term.frames.slice(-3).some((f) => f.includes(want))) await sleep(0);
  times.push(performance.now() - t0);
  await sleep(40);
}
inst.unmount();
times.sort((a, b) => a - b);
console.log(`n=${n} maxFps=${maxFps} incremental=${incremental}: median ${times[20]!.toFixed(1)}ms  p95 ${times[37]!.toFixed(1)}ms  max ${times[39]!.toFixed(1)}ms`);
process.exit(0);
