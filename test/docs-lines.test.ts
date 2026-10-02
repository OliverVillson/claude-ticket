import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const MAX = 55; // a pasted line longer than this gets split by some terminals

/** Lines inside ``` fences (sh, bash or unlabeled); comment-only lines are not typed. */
function typedLines(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let inFence = false;
  text.split('\n').forEach((l, i) => {
    if (/^\s*```/.test(l)) { inFence = !inFence; return; }
    if (inFence && l.trim() && !l.trim().startsWith('#')) out.push({ line: i + 1, text: l });
  });
  return out;
}

const section = (text: string, heading: string) => {
  const m = text.match(new RegExp(`^## ${heading}\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, 'm'));
  return m ? m[0] : '';
};

describe('typed command lines in the quickstart docs', () => {
  const files: [string, (t: string) => string][] = [
    ['docs/quickstart.md', t => t],
    ['docs/ubuntu-prep.md', t => t],
    ['README.md', t => section(t, 'Quickstart')],
  ];
  for (const [file, pick] of files) {
    test(`${file}: no line over ${MAX} characters`, () => {
      const text = pick(readFileSync(join(ROOT, file), 'utf8'));
      expect(text.length).toBeGreaterThan(0);
      const lines = typedLines(text);
      expect(lines.length).toBeGreaterThan(0);
      const tooLong = lines.filter(l => l.text.length > MAX).map(l => `${file}:${l.line} (${l.text.length}) ${l.text}`);
      expect(tooLong).toEqual([]);
    });
  }

  test('the checker catches a long line', () => {
    const long = '```sh\n' + 'x'.repeat(MAX + 1) + '\n```\n';
    expect(typedLines(long).filter(l => l.text.length > MAX)).toHaveLength(1);
  });
});

describe('install site', () => {
  test('/i and /box are copies of the scripts', () => {
    const out = join(ROOT, '.site-test');
    const r = Bun.spawnSync(['bash', join(ROOT, 'scripts/build-site.sh'), out]);
    expect(r.exitCode).toBe(0);
    for (const [url, src] of [['i', 'install.sh'], ['box', 'install-box.sh']]) {
      expect(readFileSync(join(out, url), 'utf8')).toBe(readFileSync(join(ROOT, 'scripts', src), 'utf8'));
    }
    Bun.spawnSync(['rm', '-rf', out]);
  });

  test('install.sh is valid bash and mentions gh and claude fixes', () => {
    const f = join(ROOT, 'scripts/install.sh');
    expect(Bun.spawnSync(['bash', '-n', f]).exitCode).toBe(0);
    const t = readFileSync(f, 'utf8');
    expect(t).toContain('brew install gh');
    expect(t).toContain('claude.ai/install.sh');
  });
});
