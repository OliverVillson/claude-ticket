/**
 * github.com's host key, pinned, so a box (or a project) never stops at "Are you sure you want to continue connecting".
 * This is GitHub's published ed25519 key (https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints,
 * SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU). Only ed25519 is allowed, so no other key type needs pinning.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { GITHUB_HOST_KEY, GITHUB_KNOWN_HOSTS } from '../control/hosts.ts'; // the one place the key lives

export { GITHUB_HOST_KEY };
export const KNOWN_HOSTS = GITHUB_KNOWN_HOSTS;

export function writeKnownHosts(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, KNOWN_HOSTS, { mode: 0o644 });
  chmodSync(file, 0o644);
}

/** The GIT_SSH_COMMAND that uses only this key and only the pinned host key. Paths must not contain spaces or quotes. */
export function gitSshCommand(keyFile: string, knownHosts: string): string {
  for (const p of [keyFile, knownHosts]) if (!/^[\w.\/@+-]+$/.test(p)) throw new Error(`unsafe path for ssh: ${p}`);
  return `ssh -i ${keyFile} -o IdentitiesOnly=yes -o UserKnownHostsFile=${knownHosts} -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o BatchMode=yes`;
}
