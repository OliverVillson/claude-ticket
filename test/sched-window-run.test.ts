import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The real-window script, rehearsed with the fake worker and fake meter: the report must land where the
// invoking user can read it, and the box login the runner units read (box-login.env) must reach salu.
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sched-run-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const jq = Bun.spawnSync(['jq', '--version']).exitCode === 0;

describe('scripts/sched-window-run.sh', () => {
  test.skipIf(!jq)('reads the box login, writes its report to a readable path, and passes with the fake worker', async () => {
    const root = join(dir, 'root');
    Bun.spawnSync(['mkdir', '-p', root]);
    writeFileSync(join(root, 'box-login.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test\n');
    const seen = join(dir, 'token-seen');
    const wrap = join(dir, 'salu');
    writeFileSync(wrap, `#!/bin/sh\n[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo yes >> ${seen}\nexec bun ${join(import.meta.dir, '..', 'src', 'index.ts')} "$@"\n`);
    chmodSync(wrap, 0o755);
    const out = join(dir, 'report.txt');
    const p = Bun.spawn(['bash', join(import.meta.dir, '..', 'scripts', 'sched-window-run.sh')], {
      env: {
        ...process.env,
        SALU_BOX_USER: Bun.spawnSync(['id', '-un']).stdout.toString().trim(),
        SALU: wrap,
        SALU_WORKER: 'fake',
        SALU_RUNNER_ROOT: root,
        SCHED_RUN_OUT: out,
        CLAUDE_CODE_OAUTH_TOKEN: '',
        SALU_FAKE_USAGE: JSON.stringify({ subscription_type: 'max', rate_limits: { five_hour: { utilization: 10, resets_at: '2030-01-01T00:00:00Z' } } }),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await p.exited;
    const report = readFileSync(out, 'utf8');
    expect(report).toContain('ALL PASS');
    expect(report).toContain('holdme stayed queued');
    expect(readFileSync(seen, 'utf8')).toContain('yes');
  }, 150_000);
});
