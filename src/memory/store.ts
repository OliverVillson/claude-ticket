/**
 * Per-project memory and shared files, kept in the project's own repo:
 *
 *   <root>/.salu/memory/<name>.md   one fact per file, with a small frontmatter (name, description, type)
 *   <root>/.salu/files/<path>       files every ticket of the project can read and write
 *
 * `root` is the folder a worker runs in (its kernel copy, or the project folder when the sandbox is off)
 * or the real project folder (what you edit with `salu memory` / `salu files`). Everything here treats the
 * folder as untrusted: workers can create symlinks and odd names inside `.salu/`, and `salu sync` runs
 * with your rights, so links are never followed and paths never leave `.salu/memory` or `.salu/files`.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError } from '../core/errors.ts';

export const SALU_DIR = '.salu';
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** One memory is a short fact, not a document. */
export const MEMORY_MAX_BYTES = 8 * 1024;
export const FILE_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_ENTRIES = 5000;

export const memoryDir = (root: string) => join(root, SALU_DIR, 'memory');
export const filesDir = (root: string) => join(root, SALU_DIR, 'files');

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  bytes: number;
  mtime: number;
}
export interface Memory extends MemoryEntry {
  body: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** `Build Notes.md` -> `build-notes`. Throws when nothing usable is left. */
export function memoryName(input: string): string {
  const n = input.trim().toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|-+$/g, '').slice(0, 64);
  if (!NAME_RE.test(n) || n.includes('..')) throw new CliError(`"${input}" is not a usable memory name (letters, digits, - _ .)`);
  return n;
}

/** A path under `.salu/files`: relative, no `..`, no empty or hidden-from-us segments. */
export function filePath(input: string): string {
  const parts = input.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
  if (!parts.length || input.startsWith('/') || parts.some((s) => s === '..' || s.includes('\0') || s.length > 120)) throw new CliError(`"${input}" is not a path inside the project's shared files`);
  return parts.join('/');
}

/** True when `p` exists as something other than a plain file or folder (a link, a socket, ...). */
function odd(p: string): boolean {
  try {
    const s = lstatSync(p);
    return !s.isFile() && !s.isDirectory();
  } catch {
    return false;
  }
}

/** Refuse to go through links: every folder from `base` down to the file must be a real folder. */
export function safeUnder(base: string, rel: string): string {
  let cur = base;
  for (const seg of rel.split('/')) {
    if (odd(cur)) throw new CliError(`${cur} is a link or special file; refusing to follow it`);
    cur = join(cur, seg);
  }
  if (odd(cur)) throw new CliError(`${cur} is a link or special file; refusing to follow it`);
  return cur;
}

/** `.salu` and its two folders must be real folders, not links out of the project. */
function checkRoot(root: string, sub: string): void {
  for (const p of [join(root, SALU_DIR), sub]) if (odd(p)) throw new CliError(`${p} is a link or special file; refusing to follow it`);
}

/** Regular files under `dir` (relative, `/`-separated), never following links. */
export function walkFiles(dir: string, limit = MAX_ENTRIES): string[] {
  const out: string[] = [];
  const go = (d: string, prefix: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      if (out.length >= limit) return;
      const full = join(d, n);
      let s;
      try {
        s = lstatSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) go(full, prefix + n + '/');
      else if (s.isFile()) out.push(prefix + n);
    }
  };
  go(dir, '');
  return out;
}

function atomicWrite(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// ---- memory ----------------------------------------------------------------------------------------

export function parseMemory(text: string): { name?: string; description: string; type: MemoryType; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { description: '', type: 'project', body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^\s*(name|description|type)\s*:\s*(.*)$/.exec(line) ?? /^\s+(type)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  const type = (MEMORY_TYPES as readonly string[]).includes(meta.type ?? '') ? (meta.type as MemoryType) : 'project';
  return { name: meta.name, description: meta.description ?? '', type, body: m[2]!.trim() };
}

export function formatMemory(m: { name: string; description: string; type: MemoryType; body: string }): string {
  const oneLine = m.description.replace(/\s+/g, ' ').trim();
  return `---\nname: ${m.name}\ndescription: ${oneLine}\nmetadata:\n  type: ${m.type}\n---\n\n${m.body.trim()}\n`;
}

export function listMemory(root: string): MemoryEntry[] {
  const dir = memoryDir(root);
  try {
    checkRoot(root, dir);
  } catch {
    return [];
  }
  const out: MemoryEntry[] = [];
  for (const f of walkFiles(dir).filter((f) => !f.includes('/') && f.endsWith('.md'))) {
    try {
      const text = readFileSync(join(dir, f), 'utf8');
      const p = parseMemory(text);
      out.push({ name: f.slice(0, -3), description: p.description, type: p.type, bytes: Buffer.byteLength(text), mtime: lstatSync(join(dir, f)).mtimeMs });
    } catch {
      /* unreadable: skip */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readMemory(root: string, name: string): Memory | null {
  const n = memoryName(name);
  const dir = memoryDir(root);
  checkRoot(root, dir);
  const path = join(dir, `${n}.md`);
  if (!existsSync(path) || odd(path)) return null;
  const text = readFileSync(path, 'utf8');
  const p = parseMemory(text);
  return { name: n, description: p.description, type: p.type, body: p.body, bytes: Buffer.byteLength(text), mtime: lstatSync(path).mtimeMs };
}

export function writeMemory(root: string, o: { name: string; body: string; description?: string; type?: MemoryType }): Memory {
  const name = memoryName(o.name);
  const type = o.type ?? 'project';
  if (!(MEMORY_TYPES as readonly string[]).includes(type)) throw new CliError(`memory type must be one of ${MEMORY_TYPES.join(', ')}`);
  const prev = readMemory(root, name);
  const body = o.body.trim();
  if (!body) throw new CliError('a memory needs some text');
  const text = formatMemory({ name, description: (o.description ?? prev?.description ?? firstLine(body)).slice(0, 200), type: o.type ?? prev?.type ?? 'project', body });
  if (Buffer.byteLength(text) > MEMORY_MAX_BYTES) throw new CliError(`a memory is at most ${MEMORY_MAX_BYTES / 1024} KB: split it, or keep the long version in a shared file`);
  if (!prev && listMemory(root).length >= 500) throw new CliError('this project already has 500 memories; remove some first');
  const dir = memoryDir(root);
  checkRoot(root, dir);
  atomicWrite(join(dir, `${name}.md`), text);
  return readMemory(root, name)!;
}

export function deleteMemory(root: string, name: string): boolean {
  const n = memoryName(name);
  checkRoot(root, memoryDir(root));
  const path = join(memoryDir(root), `${n}.md`);
  if (!existsSync(path) || odd(path)) return false;
  rmSync(path);
  return true;
}

const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').trim() ?? '';

// ---- shared files ----------------------------------------------------------------------------------

export interface FileEntry {
  path: string;
  bytes: number;
  mtime: number;
}

export function listFiles(root: string): FileEntry[] {
  const dir = filesDir(root);
  try {
    checkRoot(root, dir);
  } catch {
    return [];
  }
  return walkFiles(dir).map((path) => {
    const s = lstatSync(join(dir, path));
    return { path, bytes: s.size, mtime: s.mtimeMs };
  });
}

export function readFileEntry(root: string, path: string): Buffer | null {
  const rel = filePath(path);
  checkRoot(root, filesDir(root));
  const full = safeUnder(filesDir(root), rel);
  if (!existsSync(full) || !lstatSync(full).isFile()) return null;
  if (lstatSync(full).size > FILE_MAX_BYTES) throw new CliError(`${rel} is larger than ${FILE_MAX_BYTES / 1024 / 1024} MB`);
  return readFileSync(full);
}

export function writeFileEntry(root: string, path: string, data: string | Uint8Array): FileEntry {
  const rel = filePath(path);
  if (Buffer.byteLength(data as any) > FILE_MAX_BYTES) throw new CliError(`shared files are at most ${FILE_MAX_BYTES / 1024 / 1024} MB`);
  checkRoot(root, filesDir(root));
  const full = safeUnder(filesDir(root), rel);
  if (existsSync(full) && lstatSync(full).isDirectory()) throw new CliError(`${rel} is a folder`);
  atomicWrite(full, data);
  const s = lstatSync(full);
  return { path: rel, bytes: s.size, mtime: s.mtimeMs };
}

export function deleteFileEntry(root: string, path: string): boolean {
  const rel = filePath(path);
  checkRoot(root, filesDir(root));
  const full = safeUnder(filesDir(root), rel);
  if (!existsSync(full) || !lstatSync(full).isFile()) return false;
  rmSync(full);
  return true;
}

