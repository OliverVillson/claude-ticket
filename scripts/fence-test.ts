#!/usr/bin/env bun
// Does the worker fence really hold on this machine? Runs the real Claude Code with its OS sandbox (Seatbelt on
// a Mac), driven by a mock model (scripts/mock-claude-api.ts), so it needs no login and costs nothing. Two real
// runs: the kernel copy (home closed) and the fence (default mode). Canary files go in a scratch folder under
// $HOME and are removed afterwards. Exit 0 = every hard requirement held; 1 = something got out or did not run.
//   bun scripts/fence-test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSandboxCheck } from '../src/core/sandbox-check.ts';
import { sandboxSupport } from '../src/core/kernel.ts';
import { selectRunner } from '../src/orchestrator/worker.ts';
import { CONTROL_OUTPUT, startMockApi } from './mock-claude-api.ts';

const sb = sandboxSupport();
console.log(`platform ${process.platform}/${process.arch}, bun ${Bun.version}`);
if (!sb.ok) {
  console.log(`FAIL the OS sandbox cannot run here: ${sb.problem}`);
  process.exit(1);
}
const api = startMockApi();
const salu = mkdtempSync(join(tmpdir(), 'salu-fence-test-'));
process.env.ANTHROPIC_BASE_URL = api.url;
process.env.ANTHROPIC_API_KEY = 'sk-ant-mock-not-a-real-key';
process.env.SALU_HOME = salu;
delete process.env.SALU_SANDBOX;
delete process.env.SALU_WORKER;
let failed = 0;
try {
  const runner = await selectRunner();
  for (const fence of [false, true]) {
    console.log(`\n== ${fence ? 'fence (the real project folder)' : 'kernel copy (home closed)'}`);
    const probes = await runSandboxCheck(runner, { fence, control: CONTROL_OUTPUT });
    for (const p of probes) {
      console.log(`${p.ok ? 'PASS' : p.soft ? 'note' : 'FAIL'} ${p.name}: ${p.detail}`);
      if (!p.ok && !p.soft) failed++;
    }
  }
  console.log(`\nmock model answered ${api.requests()} requests`);
} finally {
  api.stop();
  rmSync(salu, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} FAILED: the fence did not hold here` : '\nALL HELD');
process.exit(failed ? 1 : 0);
