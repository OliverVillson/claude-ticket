import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { PALETTE, hex } from '../../src/ui/theme.ts';

const rgb = (r: keyof typeof PALETTE) => PALETTE[r].rgb.join(';');
const ALLOWED = new Set(Object.keys(PALETTE).map((r) => `38;2;${rgb(r as keyof typeof PALETTE)}`));

/** Render the screens with truecolor forced on, then check every colour escape is a palette colour. */
test('every rendered frame uses only palette colours (no orange, no grey dim, no default white leaks)', async () => {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, 'palette-frames.tsx')], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '3', COLORTERM: 'truecolor', NO_COLOR: undefined } as any,
  });
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  const frames: string[] = JSON.parse(out.trim().split('\n').pop()!);
  expect(frames.length).toBeGreaterThan(5);
  const seen = new Set<string>();
  const uncoloured: string[] = [];
  for (const f of frames) {
    // walk the frame tracking the foreground: any visible character with no foreground set
    // would show in the terminal's own default colour
    let fg = false;
    for (const part of f.split(/(\u001b\[[0-9;]*m)/)) {
      const m = /^\u001b\[([0-9;]*)m$/.exec(part);
      if (m) fg = m[1] === '39' || m[1] === '0' || m[1] === '' ? false : m[1]!.startsWith('38;') ? true : fg;
      else if (!fg && part.replace(/[\s\u001b\[?0-9;A-Za-z]/g, '').length) uncoloured.push(part.trim().slice(0, 40));
    }
    for (const m of f.matchAll(/\u001b\[([0-9;]*)m/g)) {
      const code = m[1]!;
      // 38 = foreground, 48 = background (the dog's half-block pixels); both must be palette colours
      if (/^(38|48);2;\d+;\d+;\d+$/.test(code)) {
        seen.add(code);
        expect(ALLOWED.has('38' + code.slice(2))).toBe(true);
      } else if (/^(39|49|1|22|7|27|0|)$/.test(code)) {
        // reset / bold / inverse are fine
      } else {
        throw new Error(`unexpected SGR ${code} (dim, 256/16-colour or background leaks)`);
      }
    }
  }
  expect(uncoloured.slice(0, 5)).toEqual([]);
  const plain = frames.map((f) => f.replace(/\u001b\[[0-9;]*m/g, ''));
  for (const want of ['new ticket', 'any key closes help', 'delete "', 'nothing matches', 'output']) expect(plain.some((f) => f.includes(want))).toBe(true);
  expect(seen.has(`38;2;${rgb('accent')}`)).toBe(true);
  expect(hex('accent')).toBe('#00ff41');
});
