import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHome } from '../core/paths.ts';
import type { MessageFile } from './format.ts';

/**
 * Phone notifications through ntfy (https://ntfy.sh): when the box posts a message, it also publishes the title
 * to a private topic, and the ntfy app on your phone shows it. Only the title leaves the box this way, never the
 * body or the worker's reply: whoever knows the topic name can read it, so the name is a long random secret.
 * Best effort: a failed publish never stops the sync.
 */
export interface NtfyConfig {
  topic: string;
  server: string;
}

const DEFAULT_SERVER = 'https://ntfy.sh';
const file = () => join(ensureHome(), 'ntfy.json');
const TOPIC_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function loadNtfy(env: NodeJS.ProcessEnv = process.env): NtfyConfig | null {
  let topic = env.SALU_NTFY_TOPIC;
  let server = env.SALU_NTFY_SERVER;
  if (!topic && existsSync(file())) {
    try {
      const o = JSON.parse(readFileSync(file(), 'utf8'));
      if (typeof o.topic === 'string') topic = o.topic;
      if (!server && typeof o.server === 'string') server = o.server;
    } catch {
      /* unreadable: treated as not set up */
    }
  }
  if (!topic || !TOPIC_RE.test(topic)) return null;
  server = (server || DEFAULT_SERVER).replace(/\/+$/, '');
  return /^https?:\/\//.test(server) ? { topic, server } : null;
}

export function saveNtfy(topic: string, server?: string): NtfyConfig {
  if (!TOPIC_RE.test(topic)) throw new Error('a topic is 8 to 64 letters, digits, - or _');
  const cfg = { topic, server: (server || DEFAULT_SERVER).replace(/\/+$/, '') };
  writeFileSync(file(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return cfg;
}

export const newTopic = () => `salu-${randomBytes(12).toString('hex')}`;

const PRIORITY: Record<MessageFile['level'], string> = { info: '3', success: '3', warn: '4', error: '4' };
const TAGS: Record<MessageFile['level'], string> = { info: 'information_source', success: 'white_check_mark', warn: 'warning', error: 'x' };

/**
 * What tapping the notification opens: the Salu iPhone app on that ticket (`salu://ticket/<project>/<number>`, with the
 * phone's own ticket id when it sent it), or its inbox. Only names and numbers go in, like the title.
 */
export function clickUrl(m: Pick<MessageFile, 'project' | 'ticket'>): string {
  const project = encodeURIComponent(m.project);
  if (!m.ticket || !Number.isInteger(m.ticket.id)) return `salu://inbox?project=${project}`;
  const ref = m.ticket.ref && /^[A-Za-z0-9_-]{1,64}$/.test(m.ticket.ref) ? `?ref=${m.ticket.ref}` : '';
  return `salu://ticket/${project}/${m.ticket.id}${ref}`;
}

type Publishable = Pick<MessageFile, 'title' | 'level' | 'project' | 'type'> & Partial<Pick<MessageFile, 'ticket'>>;

/** curl's arguments for one publish (kept apart so a test can read the headers). */
export function ntfyArgs(m: Publishable, cfg: NtfyConfig): string[] {
  return [
    '-fsS', '--max-time', '8',
    '-H', `Title: salu · ${m.project}`.replace(/[\r\n]/g, ' '),
    '-H', `Priority: ${PRIORITY[m.level] ?? '3'}`,
    '-H', `Tags: ${TAGS[m.level] ?? 'information_source'}`,
    '-H', `Click: ${clickUrl(m)}`,
    '--data-raw', m.title.slice(0, 300), // not -d: a title starting with @ would make curl send a file
    `${cfg.server}/${cfg.topic}`,
  ];
}

/** Publish one message. Returns an error text, or null when it went out (or ntfy is not set up). */
export function publishNtfy(m: Publishable, cfg: NtfyConfig | null = loadNtfy()): string | null {
  if (!cfg) return null;
  try {
    const r = spawnSync('curl', ntfyArgs(m, cfg), { encoding: 'utf8', timeout: 10_000 });
    return r.status === 0 ? null : (r.stderr || r.error?.message || 'curl failed').trim().slice(0, 200);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
