/**
 * Contact sheet of every dog frame and the status glyphs, for checking the art by eye:
 * `bun run src/tui/dog/sheet.ts [level]` (level 0-3, default 3). Pipe it to a file and
 * rasterise it, or just look at it in a terminal.
 */
import type { ColorLevel } from '../../ui/theme.ts';
import { ASCII_GLYPHS, UNICODE_GLYPHS } from '../../ui/glyphs.ts';
import { painter } from '../../ui/theme.ts';
import { dogFrame, sleepFrame } from './line.ts';
import { frameCount, renderDog } from './render.ts';

const level = Number(process.argv[2] ?? 3) as ColorLevel;
const out: string[] = [];
const row = (blocks: string[][], gap = '   ') => {
  const h = Math.max(...blocks.map((b) => b.length));
  const w = blocks.map((b) => Math.max(...b.map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').length)));
  for (let i = 0; i < h; i++)
    out.push(blocks.map((b, k) => { const l = b[i] ?? ''; return l + ' '.repeat(w[k]! - l.replace(/\u001b\[[0-9;]*m/g, '').length); }).join(gap));
  out.push('');
};
for (const size of ['full', 'mini'] as const) {
  row(Array.from({ length: frameCount('run', size) }, (_, t) => renderDog(t, { size, level })));
  row(Array.from({ length: frameCount('sleep', size) }, (_, t) => renderDog(t * 8, { size, level, mode: 'sleep' })));
}
out.push(Array.from({ length: 4 }, (_, t) => dogFrame(t, { level })).join('   ') + '   ' + sleepFrame({ level }));
out.push('');
const p = (r: Parameters<typeof painter>[0]) => painter(r, level);
for (const g of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
  out.push(
    [p('accent')(g.running) + ' running', p('paused')(g.paused) + ' paused', p('chrome')(g.todo) + ' todo', p('warn')(g.blocked) + ' blocked',
      p('error')(g.failed) + ' failed', p('ok')(g.done) + ' done'].join('   '),
  );
  out.push(
    [p('accent')(g.mark) + p('accent')('salu') + p('chrome')(` ${g.crumb} `) + 'web', p('accent')(g.on + ' orchestrator on'), p('chrome')(g.off + ' orchestrator off'),
      p('accent')(g.cursor), p('accent')(g.spinner.join(' '))].join('   '),
  );
  out.push('');
}
console.log(out.join('\n'));
