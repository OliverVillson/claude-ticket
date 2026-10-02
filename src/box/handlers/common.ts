import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BoxDeps, HandlerResult } from './types.ts';

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const REPO_RE = /^git@github\.com:[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}\.git$/;

export const bad = (message: string): HandlerResult => ({ ok: false, message });

/** The line of a command's output a person should read: the last non-empty line that is not a hint. */
export function firstProblem(out: string): string {
  const lines = out.split('\n').map((l) => l.replace(/^[✗!·\s]+/, '').trim()).filter(Boolean);
  return (lines.find((l) => /error|cannot|could not|failed|refus|not |no /i.test(l)) ?? lines[0] ?? 'it gave no reason').slice(0, 300);
}

/** Write secrets to private files for one command, then remove them whatever happens. Never in a command line or a log. */
export async function withSecretFiles<T>(deps: BoxDeps, files: Record<string, Buffer>, fn: (paths: Record<string, string>) => Promise<T>): Promise<T> {
  mkdirSync(deps.tmpDir, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(deps.tmpDir, 'cmd-'));
  try {
    chmodSync(dir, 0o700); // `salu runner add` runs as root, reads these, and copies them into the project's folder
    const paths: Record<string, string> = {};
    for (const [k, v] of Object.entries(files)) {
      paths[k] = join(dir, k);
      writeFileSync(paths[k]!, v, { mode: 0o600 });
    }
    return await fn(paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
