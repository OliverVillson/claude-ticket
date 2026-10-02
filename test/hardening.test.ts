import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditKernel, orchestratorEnvToScrub } from '../src/core/kernel.ts';
import { failureTail, judge, plantCanaries, ticketText } from '../src/core/sandbox-check.ts';

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
  const attempts = (c: ReturnType<typeof plantCanaries>) =>
    [`cat ${c.readFile}`, '"name":"Read"', c.readFile, `echo x > ${c.writeTarget}`, '"name":"Write"', c.overwriteTarget, `ln ${c.linkSource}`, '/proc/1/environ'].join('\n');
  test('every probe needs a real attempt in the log', () => {
    const c = plantCanaries(root, 'ENV-CANARY-x');
    try {
      expect(ticketText(c, 123)).toContain(c.readFile);
      expect(ticketText(c, 123)).not.toContain(c.envValue);
      const good = judge(c, attempts(c), { kernelHasLink: false, ran: true, envChecked: true });
      expect(good.filter((p) => !p.ok)).toEqual([]);
      const untried = judge(c, 'the agent said everything was refused', { kernelHasLink: false, ran: true, envChecked: true });
      expect(untried.filter((p) => !p.ok)).toHaveLength(6);
      expect(untried[1]!.detail).toContain('not tested');
      expect(judge(c, attempts(c), { kernelHasLink: false, ran: true })[6]).toMatchObject({ ok: false, soft: true });
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });
  test('a leak, a write outside or a link is reported per probe', () => {
    const c = plantCanaries(root, 'ENV-CANARY-x');
    try {
      const bad = judge(c, `${attempts(c)} ${c.secret} ENV-CANARY-x`, { kernelHasLink: true, ran: true, envChecked: true });
      expect(bad.filter((p) => !p.ok).map((p) => p.name)).toEqual(['shell cannot read a secret file under your home', 'Read tool cannot read a secret file under your home', 'no hard link into your home folder', 'orchestrator environment hidden from the shell']);
      writeFileSync(c.writeTarget, 'x');
      writeFileSync(c.overwriteTarget, 'changed');
      const w = judge(c, attempts(c), { kernelHasLink: false, ran: true, envChecked: true });
      expect(w.filter((p) => !p.ok).map((p) => p.name)).toEqual(['shell cannot write outside the kernel', 'file tools cannot overwrite a file outside the kernel']);
      expect(judge(c, '', { kernelHasLink: false, ran: false })).toHaveLength(1);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });
});

describe('execReplace', () => {
  test('the restarted process has the same pid and none of the old environment', async () => {
    const script = join(root, 'exec-probe.ts');
    writeFileSync(script, `import { execReplace } from '${join(import.meta.dir, '../src/core/exec.ts')}';
if (process.env.STAGE === '2') console.log(JSON.stringify({ pid: process.pid, parent: process.env.FIRST_PID, token: !!process.env.GITHUB_TOKEN, environ: process.platform === 'linux' ? (await Bun.file('/proc/self/environ').text()).includes('ghp_secret') : false }));
else await execReplace([process.execPath, '${script}'], { PATH: process.env.PATH, STAGE: '2', FIRST_PID: String(process.pid) });`);
    const r = Bun.spawnSync([process.execPath, script], { env: { PATH: process.env.PATH!, GITHUB_TOKEN: 'ghp_secret' }, stdout: 'pipe' });
    const out = JSON.parse(r.stdout.toString());
    expect(out.pid).toBe(Number(out.parent));
    expect(out.token).toBe(false);
    expect(out.environ).toBe(false);
  });
});

describe('the sandbox check says why a ticket did not run', () => {
  test('the worker\'s stderr and error go into the failing probe', () => {
    const log = JSON.stringify({ type: 'stderr', text: 'Invalid API key' }) + '\nClaude Code process exited with code 1';
    expect(failureTail(log)).toContain('Invalid API key');
    expect(failureTail(log)).toContain('exited with code 1');
    expect(failureTail('')).toContain('nothing at all');
    expect(failureTail(JSON.stringify({ type: 'stderr', text: 'import{Le}from"/$bunfs/x.js"' }))).toContain('Raw end');
    // a crash dump of bundled source followed by the real error: only the error survives
    const dump = JSON.stringify({ type: 'stderr', text: '// (c) Anthropic PBC\nimport{Le,gs}from"/$bunfs/root/chunk-51c5swn7.js";' + 'x'.repeat(400) + '\nerror: EACCES: permission denied, mkdir \'/root/.claude\'\nBun v1.3' });
    const t = failureTail(dump);
    expect(t).toContain('EACCES');
    expect(t).not.toContain('bunfs');
  });
});
