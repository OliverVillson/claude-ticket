import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditKernel, orchestratorEnvToScrub } from '../src/core/kernel.ts';
import { judge, plantCanaries, ticketText } from '../src/core/sandbox-check.ts';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'salu-hard-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('orchestrator environment scrub', () => {
  const env = { PATH: '/bin', HOME: '/h', GITHUB_TOKEN: 'ghp_x', DATABASE_URL: 'pg://', SALU_ENV_PASS: 'DATABASE_URL', SALU_HOME: '/s' };
  test('nothing to do without a sandboxed project, or when already clean, or when kept', () => {
    expect(orchestratorEnvToScrub(false, env)).toBeNull();
    expect(orchestratorEnvToScrub(true, { ...env, SALU_ORCH_SCRUBBED: '1' })).toBeNull();
    expect(orchestratorEnvToScrub(true, { ...env, SALU_ORCH_ENV: 'keep' })).toBeNull();
    expect(orchestratorEnvToScrub(true, { ...env, SALU_SANDBOX: 'off' })).toBeNull();
  });
  test('keeps what workers get plus SALU_ENV_PASS, drops the rest, marks itself clean', () => {
    const out = orchestratorEnvToScrub(true, env)!;
    expect(out.PATH).toBe('/bin');
    expect(out.SALU_HOME).toBe('/s');
    expect(out.DATABASE_URL).toBe('pg://');
    expect(out.GITHUB_TOKEN).toBeUndefined();
    expect(out.SALU_ORCH_SCRUBBED).toBe('1');
    expect(out.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
  });
});

describe('auditKernel', () => {
  test('a clean kernel has no findings', () => {
    const k = join(root, 'clean');
    mkdirSync(join(k, 'src'), { recursive: true });
    writeFileSync(join(k, 'src', 'a.ts'), 'x');
    symlinkSync('a.ts', join(k, 'src', 'inner-link'));
    expect(auditKernel(k, { home: root })).toEqual([]);
  });
  test('reports links that leave the kernel and files with several hard links', () => {
    const k = join(root, 'dirty');
    mkdirSync(k);
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(k, 'out-link'));
    symlinkSync(join(root, 'not-there'), join(k, 'dangling'));
    linkSync(outside, join(k, 'hard'));
    const f = auditKernel(k, { home: root }).join('\n');
    expect(f).toContain('out-link is a link to');
    expect(f).toContain('dangling is a link to');
    expect(f).toContain('hard has 2 hard links');
  });
});

describe('sandbox proof verdicts', () => {
  test('a session that leaked, wrote or linked is reported per probe', () => {
    const c = plantCanaries(root);
    try {
      expect(ticketText(c, 123)).toContain(c.readFile);
      expect(judge(c, 'clean log', { kernelHasLink: false, ran: true }).every((p) => p.ok)).toBe(true);
      const bad = judge(c, `tool_result ${c.secret} ${c.envValue}`, { kernelHasLink: true, ran: true });
      expect(bad.filter((p) => !p.ok).map((p) => p.name)).toEqual(['secret file under your home stays unread', 'no hard link into your home folder', 'orchestrator environment hidden from the shell']);
      writeFileSync(c.writeTarget, 'x');
      writeFileSync(c.overwriteTarget, 'changed');
      const w = judge(c, '', { kernelHasLink: false, ran: true });
      expect(w.filter((p) => !p.ok).map((p) => p.name)).toEqual(['shell cannot write outside the kernel', 'file tools cannot overwrite a file outside the kernel']);
      expect(judge(c, '', { kernelHasLink: false, ran: false })).toHaveLength(1);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });
});
