import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { resolveProject } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { insideWorker, kernelPath } from '../../core/kernel.ts';
import { dim, green } from '../../core/ansi.ts';
import { MEMORY_TYPES, type MemoryType, deleteFileEntry, deleteMemory, formatMemory, listFiles, listMemory, memoryName, readFileEntry, readMemory, writeFileEntry, writeMemory } from '../../memory/store.ts';
import { helpIf } from './_shared.ts';

const MEMORY_HELP = `salu memory [list] [--project P] [--kernel] [--json]     what the project's agents remember
salu memory show <name>                                  one memory in full
salu memory add <name> ["text"] [--description D] [--type user|feedback|project|reference]
                                                         save a memory (no text: read it from stdin)
salu memory edit <name>                                  change a memory in $EDITOR (it is made if missing)
salu memory rm <name> [--yes]                            forget one

Memory is kept in the project's repo, in .salu/memory/<name>.md, one fact per file. Every ticket
reads all of it when it starts and can add to it. Agents write in their sandbox copy (the kernel);
\`salu sync\` merges it with the project folder and git. These commands work on the project folder's
copy; --kernel shows (and edits) the sandbox copy instead.`;

const FILES_HELP = `salu files [list] [--project P] [--kernel] [--json]       the project's shared files
salu files get <path> [--out file]                       print a shared file (or save it to --out)
salu files add <path> [--from local-file | "text"]       put a file in the shared folder
salu files rm <path> [--yes]                             delete one

Shared files live in .salu/files/ in the project repo. Every ticket can read and write them, and
\`salu sync\` carries them between the sandbox copy, the project folder and git. --kernel works on the
sandbox copy.`;

function rootFor(p: Parsed): { root: string; name: string; kernel: boolean } {
  const db = openDb();
  const project = resolveProject(db, flagStr(p, 'project'));
  if (flagBool(p, 'kernel')) {
    const k = kernelPath(project.name);
    if (!existsSync(k)) throw new CliError(`no sandbox copy of "${project.name}" yet (it is made when its first ticket runs)`);
    return { root: k, name: project.name, kernel: true };
  }
  return { root: project.path, name: project.name, kernel: false };
}

const ago = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 90 ? 'now' : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

function editInEditor(initial: string): string {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor || !process.stdin.isTTY) throw new CliError('set $EDITOR (or pass the text: salu memory add <name> "text")');
  const dir = mkdtempSync(join(tmpdir(), 'salu-memory-'));
  const file = join(dir, 'memory.md');
  try {
    writeFileSync(file, initial);
    const r = Bun.spawnSync(['sh', '-c', `${editor} "$1"`, 'sh', file], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    if (r.exitCode !== 0) throw new CliError(`${editor} exited with ${r.exitCode}; nothing saved`);
    return readFileSync(file, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function stdinText(): Promise<string> {
  if (process.stdin.isTTY) throw new CliError('give the text as an argument or pipe it in');
  return await new Response(Bun.stdin.stream()).text();
}

export async function memory(p: Parsed): Promise<number> {
  if (helpIf(p, MEMORY_HELP)) return 0;
  if (insideWorker()) throw new CliError('salu memory is for you; agents use the files in .salu/memory/ directly');
  const [verbRaw, ...rest] = p.positional;
  const verb = verbRaw ?? 'list';
  const { root, name: project, kernel } = rootFor(p);
  switch (verb) {
    case 'list':
    case 'ls': {
      const list = listMemory(root);
      if (flagBool(p, 'json')) {
        console.log(JSON.stringify(list, null, 2));
        return 0;
      }
      if (!list.length) console.log(dim(`no memory yet for ${project}${kernel ? ' (sandbox copy)' : ''}: agents add to it as they work, or run: salu memory add <name> "text"`));
      for (const m of list) console.log(`${green(m.name.padEnd(28))} ${m.type.padEnd(9)} ${dim(ago(m.mtime).padEnd(8))} ${m.description}`);
      return 0;
    }
    case 'show':
    case 'cat': {
      const m = readMemory(root, need(rest[0], 'salu memory show <name>'));
      if (!m) throw new CliError(`no memory named "${rest[0]}"`);
      console.log(formatMemory(m).trimEnd());
      return 0;
    }
    case 'add':
    case 'set': {
      const name = need(rest[0], 'salu memory add <name> "text"');
      const body = rest.slice(1).join(' ').trim() || (await stdinText()).trim();
      const type = flagStr(p, 'type');
      if (type && !(MEMORY_TYPES as readonly string[]).includes(type)) throw new CliError(`--type must be one of ${MEMORY_TYPES.join(', ')}`);
      const m = writeMemory(root, { name, body, description: flagStr(p, 'description'), type: type as MemoryType | undefined });
      console.log(`${green('✓')} saved memory ${m.name} ${dim(kb(m.bytes) + (kernel ? '' : '; agents see it when their next ticket starts'))}`);
      return 0;
    }
    case 'edit': {
      const n = memoryName(need(rest[0], 'salu memory edit <name>'));
      const prev = readMemory(root, n);
      const initial = prev ? formatMemory(prev) : formatMemory({ name: n, description: 'one line: when is this useful', type: 'project', body: 'The fact.\n\n**Why:** \n**How to apply:** ' });
      const edited = editInEditor(initial);
      if (edited === initial) {
        console.log(dim('no change'));
        return 0;
      }
      const { parseMemory } = await import('../../memory/store.ts');
      const parsed = parseMemory(edited);
      const m = writeMemory(root, { name: n, body: parsed.body, description: parsed.description, type: parsed.type });
      console.log(`${green('✓')} saved memory ${m.name}`);
      return 0;
    }
    case 'rm':
    case 'remove':
    case 'delete': {
      const n = need(rest[0], 'salu memory rm <name>');
      if (!readMemory(root, n)) throw new CliError(`no memory named "${n}"`);
      if (!flagBool(p, 'yes') && !(await (await import('./_shared.ts')).confirm(p, `forget "${n}"?`))) return 1;
      deleteMemory(root, n);
      console.log(`${green('✓')} forgot ${n}`);
      return 0;
    }
    default:
      throw new CliError(`unknown memory command "${verb}"\n\n${MEMORY_HELP}`);
  }
}

export async function files(p: Parsed): Promise<number> {
  if (helpIf(p, FILES_HELP)) return 0;
  if (insideWorker()) throw new CliError('salu files is for you; agents use the files in .salu/files/ directly');
  const [verbRaw, ...rest] = p.positional;
  const verb = verbRaw ?? 'list';
  const { root, name: project, kernel } = rootFor(p);
  switch (verb) {
    case 'list':
    case 'ls': {
      const list = listFiles(root);
      if (flagBool(p, 'json')) {
        console.log(JSON.stringify(list, null, 2));
        return 0;
      }
      if (!list.length) console.log(dim(`no shared files yet for ${project}${kernel ? ' (sandbox copy)' : ''}: salu files add <path> --from <file>`));
      for (const f of list) console.log(`${green(f.path.padEnd(40))} ${kb(f.bytes).padStart(9)} ${dim(ago(f.mtime))}`);
      return 0;
    }
    case 'get':
    case 'cat': {
      const path = need(rest[0], 'salu files get <path>');
      const data = readFileEntry(root, path);
      if (!data) throw new CliError(`no shared file "${path}"`);
      const out = flagStr(p, 'out');
      if (out) {
        writeFileSync(out, data);
        console.log(`${green('✓')} saved ${path} to ${out}`);
      } else process.stdout.write(data);
      return 0;
    }
    case 'add':
    case 'put': {
      const path = need(rest[0], 'salu files add <path> --from <file>');
      const from = flagStr(p, 'from');
      const data = from ? readFileSync(from) : rest.length > 1 ? rest.slice(1).join(' ') : await stdinText();
      const f = writeFileEntry(root, path, data);
      console.log(`${green('✓')} saved ${f.path} ${dim(kb(f.bytes))}`);
      return 0;
    }
    case 'rm':
    case 'remove':
    case 'delete': {
      const path = need(rest[0], 'salu files rm <path>');
      if (!readFileEntry(root, path)) throw new CliError(`no shared file "${path}"`);
      if (!flagBool(p, 'yes') && !(await (await import('./_shared.ts')).confirm(p, `delete ${path}?`))) return 1;
      deleteFileEntry(root, path);
      console.log(`${green('✓')} deleted ${path}`);
      return 0;
    }
    default:
      throw new CliError(`unknown files command "${verb}"\n\n${FILES_HELP}`);
  }
}

function need(v: string | undefined, usage: string): string {
  if (!v) throw new CliError(`usage: ${usage}`);
  return v;
}
