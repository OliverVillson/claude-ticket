import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');

async function run(...args: string[]) {
  const p = Bun.spawn([process.execPath, ENTRY, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, SALU_HOME: join(import.meta.dir, '..', '.ticket-test', 'help'), NO_COLOR: '1' } });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

describe('help', () => {
  for (const args of [['?'], ['help'], ['--help']]) {
    test(`ticket ${args.join(' ')} lists every command`, async () => {
      const r = await run(...args);
      expect(r.code).toBe(0);
      for (const cmd of ['add project', 'add "name"', 'remove', 'change', 'list', 'run', 'pause', 'resume', 'stop', 'status', 'log', 'plan', 'update']) {
        expect(r.out).toContain(cmd);
      }
    });
  }
  test('an unknown command fails and shows the help', async () => {
    const r = await run('nope');
    expect(r.code).toBe(1);
    expect(r.err).toContain('unknown command');
  });
});
