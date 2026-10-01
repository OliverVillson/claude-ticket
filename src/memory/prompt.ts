import { listMemory, readMemory } from './store.ts';

/** Memory bodies go into the prompt in full up to this size; beyond it the worker gets the index and reads what it needs. */
export const PROMPT_BODY_BUDGET = 16 * 1024;

/**
 * What every worker is told about the project's memory and shared files when it starts.
 * `root` is the folder the worker runs in. Returns '' for nothing at all (no memory yet still gets the
 * how-to, so the first worker knows it may create some).
 */
export function memoryPrompt(root: string): string {
  const entries = listMemory(root);
  const lines = [
    'Project memory and shared files (kept in the project repo under `.salu/`, shared by every ticket of this project):',
    '- `.salu/memory/<name>.md`: short notes that stay true across tickets. One fact per file, starting with the lines `---`, `name: <name>`, `description: <one line>`, `metadata:`, `  type: user|feedback|project|reference`, `---`, then the note. Add or fix a note when you learn something a later ticket would otherwise have to rediscover (decisions, conventions, how to run things); remove a note that turned out wrong. Never save secrets. Do not record what the code or git history already shows.',
    '- `.salu/files/`: files you and other tickets can share (data, drafts, plans, scripts). Read and write them freely.',
    '- Both are plain files, so use your normal file tools. Never commit `.salu/` to a ticket branch; it is synced separately when the human runs `salu sync`.',
  ];
  if (!entries.length) return [...lines, '', 'Memory: empty so far.'].join('\n');
  const bodies = entries.map((e) => ({ e, m: readMemory(root, e.name) })).filter((x) => x.m);
  const total = bodies.reduce((n, x) => n + x.m!.body.length, 0);
  lines.push('', 'Memory index:');
  for (const { e } of bodies) lines.push(`- ${e.name} (${e.type}): ${e.description || '(no description)'}`);
  if (total <= PROMPT_BODY_BUDGET) {
    for (const { e, m } of bodies) lines.push('', `--- memory: ${e.name} ---`, m!.body);
  } else {
    lines.push('', 'The notes are long: read the ones that matter to this ticket from `.salu/memory/<name>.md` before you start.');
  }
  return lines.join('\n');
}
