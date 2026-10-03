import { expect, test } from 'bun:test';
import { judge, plantCanaries, ticketText } from '../src/core/sandbox-check.ts';
import { attemptsFrom, CONTROL_OUTPUT } from '../scripts/mock-claude-api.ts';
import { rmSync } from 'node:fs';

test('the mock model turns the self-test ticket into seven tool calls', () => {
  const c = plantCanaries();
  try {
    const calls = attemptsFrom(ticketText(c, 123));
    expect(calls.map((x) => x.name)).toEqual(['Bash', 'Read', 'Bash', 'Write', 'Bash', 'Bash', 'Bash']);
    expect(calls[1]!.input.file_path).toBe(c.readFile);
    expect(calls[3]!.input.file_path).toBe(c.overwriteTarget);
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test('with a control, a refusal only counts if the commands reached the sandbox', () => {
  const c = plantCanaries();
  try {
    const base = `cat ${c.readFile} "Read" ${c.readFile} echo x > ${c.writeTarget} "Write" ${c.overwriteTarget} ln ${c.linkSource} /proc/1/environ`;
    const ran = judge(c, base + CONTROL_OUTPUT, { kernelHasLink: false, ran: true, control: CONTROL_OUTPUT });
    expect(ran.every((p) => p.ok || p.name.includes('environment'))).toBe(true);
    const noControl = judge(c, base, { kernelHasLink: false, ran: true, control: CONTROL_OUTPUT });
    expect(noControl.find((p) => p.name.startsWith('a harmless command'))!.ok).toBe(false);
    const denied = judge(c, base + CONTROL_OUTPUT + '\n' + JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't1', decision_reason_type: 'asyncAgent' }), { kernelHasLink: false, ran: true, control: CONTROL_OUTPUT });
    expect(denied.find((p) => p.name.startsWith('no attempt was stopped'))!.ok).toBe(false);
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});
