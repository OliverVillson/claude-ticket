/**
 * Environment for worker processes.
 *
 * When `ticket run` is started from inside a Claude Code session (an agent, a terminal tool,
 * a cloud session) that session's identity travels in CLAUDE_* variables: its session id,
 * its transport sockets and tokens, its remote-session ids. A worker that inherits them
 * reports the parent's session id (so a later `resume` would resume the parent) and may write
 * into the parent's transcript. Workers therefore get the environment minus those variables.
 * Auth, provider, proxy and model variables are kept.
 *
 * Escape hatch: TICKET_INHERIT_CLAUDE_ENV=1 passes everything through.
 */
const PARENT_SESSION_VAR =
  /SESSION|INGRESS|MESSAGING|REMOTE|CHILD|WORKER_EPOCH|CCR|ENTRYPOINT|DIAGNOSTICS|TEE_SDK|INCLUDE_PARTIAL|CONTAINER_ID|AFTER_LAST_COMPACT/;

export function isParentSessionVar(name: string): boolean {
  if (name === 'CLAUDECODE' || name === 'CLAUDE_PID') return true;
  return name.startsWith('CLAUDE_') && PARENT_SESSION_VAR.test(name);
}

export function workerEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  if (base.TICKET_INHERIT_CLAUDE_ENV === '1') return { ...base };
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) {
    if (isParentSessionVar(k)) continue;
    out[k] = v;
  }
  return out;
}
