// The released artefact, not the source: the compiled salu binary has no Claude Code of its own, so it
// must find the installed one, say so clearly when there is none, and never fail tickets over it.
// Runs against SALU_E2E_BIN, else dist/salu; skipped when neither exists (plain `bun test` before a build).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const BIN = process.env.SALU_E2E_BIN ? resolve(process.env.SALU_E2E_BIN) : resolve(import.meta.dir, '../../dist/salu');
const STUB = resolve(import.meta.dir, '../fixtures/stub-claude');
const maybe = existsSync(BIN) ? describe : describe.skip;

let root: string;
let cwd: string;
let stubDir: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'salu-e2e-'));
  cwd = join(root, 'work');
  stubDir = join(root, 'stub-bin');
  mkdirSync(cwd);
  mkdirSync(stubDir);
  Bun.spawnSync(['cp', STUB, join(stubDir, 'claude')]);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

// A PATH that has bun (the stub's interpreter) and the system, but no claude unless asked for.
const basePath = `${dirname(process.execPath)}:/usr/bin:/bin`;
function env(withStub: boolean, extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: root, PATH: withStub ? `${stubDir}:${basePath}` : basePath, SALU_HOME: join(root, 'home'), SALU_NO_TUI: '1', ...extra };
}
async function salu(args: string[], e: Record<string, string>) {
  const p = Bun.spawn([BIN, ...args], { cwd, env: e, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}
const tickets = async (e: Record<string, string>) => JSON.parse((await salu(['list', '--json'], e)).out) as any[];

maybe('compiled salu binary', () => {
  test('without Claude Code: doctor and run explain how to install it, and the ticket stays untouched', async () => {
    const e = env(false);
    expect((await salu(['add', 'hello', 'say hello'], e)).code).toBe(0);
    const d = await salu(['doctor'], e);
    expect(d.code).toBe(1);
    expect(d.out).toContain('claude.ai/install.sh');
    const r = await salu(['run', '--plain'], e);
    expect(r.code).toBe(1);
    expect(r.err).toContain('could not find Claude Code');
    expect(r.err).not.toContain('Native CLI binary');
    const t = (await tickets(e))[0];
    expect(t.status).toBe('backlog');
    expect(t.attempts).toBe(0);
  });

  test('with a claude on PATH: doctor is happy and a ticket runs to done', async () => {
    const e = env(true);
    const d = await salu(['doctor'], e);
    if (d.code !== 0 || !d.out.includes('Claude Code 9.9.9')) console.error('doctor said:', d.code, d.out, d.err);
    expect(d.out).toContain('Claude Code 9.9.9');
    expect(d.code).toBe(0);
    const p = Bun.spawn([BIN, 'run', '--plain'], { cwd, env: e, stdout: 'pipe', stderr: 'pipe' });
    try {
      const end = Date.now() + 40_000;
      let status = 'todo';
      let last = '';
      while (Date.now() < end) {
        try {
          status = (await tickets(e))[0].status;
        } catch (err: any) {
          last = String(err?.message ?? err); // a read that races the orchestrator's first write: try again
        }
        if (status === 'done') break;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (status !== 'done') console.error('run output:', await Promise.race([new Response(p.stdout).text(), new Promise((r) => setTimeout(() => r('(still running)'), 500))]), last);
      expect(status).toBe('done');
    } finally {
      p.kill('SIGTERM');
      await p.exited;
    }
  }, 60_000);

  test('SALU_CLAUDE_PATH overrides PATH, and a wrong one is reported, not ignored', async () => {
    const good = await salu(['doctor'], env(false, { SALU_CLAUDE_PATH: join(stubDir, 'claude') }));
    expect(good.code).toBe(0);
    const bad = await salu(['doctor'], env(true, { SALU_CLAUDE_PATH: '/nope/claude' }));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('SALU_CLAUDE_PATH points to /nope/claude');
  });
});
