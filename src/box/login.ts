/**
 * The one box login. One Claude token (from `claude setup-token`) serves every runner project's orchestrator and the
 * kernel's API proxy, so a person gives the box a login once instead of once per project and once for the kernel.
 *
 *   <root>/kernel-token    the token; what the kernel proxy and `SALU_KERNEL_TOKEN_FILE` read (same path as before)
 *   <root>/box-login.env   CLAUDE_CODE_OAUTH_TOKEN=<token>; read by every salu-runner@ unit (EnvironmentFile)
 *
 * To split it again (a separately revocable token for agents): write the agent token to kernel-token and give each
 * project its own with `salu runner add --token-file`; <project>.env is read after box-login.env, so it wins.
 */
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from '../core/errors.ts';
import { runnerRoot } from '../core/runner.ts';

export const boxLoginFile = (env: NodeJS.ProcessEnv = process.env) => join(runnerRoot(env), 'kernel-token');
export const boxLoginEnvFile = (env: NodeJS.ProcessEnv = process.env) => join(runnerRoot(env), 'box-login.env');

/** A setup-token or API key: one token's worth of characters, nothing a shell or env file could misread. */
export function validToken(t: string): boolean {
  return t.length >= 8 && t.length <= 4096 && /^[A-Za-z0-9._~+\/=-]+$/.test(t);
}

export function readBoxLogin(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    return readFileSync(boxLoginFile(env), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writePrivate(file: string, text: string, owner?: { uid: number; gid: number }): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  if (owner && process.getuid?.() === 0) chownSync(tmp, owner.uid, owner.gid);
  renameSync(tmp, file);
}

/** Save the box login for the kernel and for every runner project. `owner`: the runner user, when running as root. */
export function saveBoxLogin(token: string, o: { env?: NodeJS.ProcessEnv; owner?: { uid: number; gid: number } } = {}): void {
  const t = token.trim();
  if (!validToken(t)) throw new CliError('that does not look like a Claude token: run `claude setup-token` and use the whole line it prints');
  const owner = o.owner ?? ownerOfRoot(o.env);
  writePrivate(boxLoginFile(o.env), t + '\n', owner);
  writePrivate(boxLoginEnvFile(o.env), `CLAUDE_CODE_OAUTH_TOKEN=${t}\n`, owner);
}

/** The runner folder is owned by the runner user (runner setup); files in it keep that owner. */
function ownerOfRoot(env?: NodeJS.ProcessEnv): { uid: number; gid: number } | undefined {
  try {
    const s = statSync(runnerRoot(env));
    return s.uid === 0 ? undefined : { uid: s.uid, gid: s.gid };
  } catch {
    return undefined;
  }
}

export const hasBoxLogin = (env: NodeJS.ProcessEnv = process.env) => existsSync(boxLoginFile(env)) && !!readBoxLogin(env);
