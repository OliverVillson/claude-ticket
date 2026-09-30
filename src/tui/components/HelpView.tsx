import React from 'react';
import { Text } from 'ink';
import { Frame, titleText } from './Frame.tsx';
import { style as st } from '../style.ts';

const KEYS: Array<[string, string]> = [
  ['↑ ↓  j k', 'move the cursor'],
  ['pgup pgdn  ctrl-u ctrl-d', 'move a page'],
  ['g  G  home  end', 'first / last ticket'],
  ['⏎', 'open the ticket: query, tags, last run, live log tail'],
  ['a', 'add a ticket (name, query, tags)'],
  ['e', 'edit the selected ticket'],
  ['d', 'delete the selected ticket (asks y/n)'],
  ['a', 'on a ticket blocked by a permission: allow what it was refused and queue it again'],
  ['u', 'queue the selected ticket (saved tickets stay in the backlog until then), or take a queued one back'],
  ['r', 'run the selected ticket next, ahead of the queue'],
  ['p', 'pause or resume the orchestrator'],
  ['/', 'filter as you type: bug  #label  status:running  p1  p<=2  @project  model:opus  -done'],
  [':', 'command line (tab to it, or press :): any salu command, e.g. add "fix login"  add project web  run  status  (tab completes, ↑↓ history)'],
  ['←  →  (project tree)', 'inside the tree only: → opens a project or enters a subproject, ← collapses it or goes back up'],
  ['→  (finished ticket)', 'opens its output: the result, the error if it failed, and the whole transcript (↑↓ scroll, [ ] earlier runs, p properties)'],
  ['▸  (end of a row)', 'the selected row ends in an arrow when → goes deeper: a project with subprojects, a ticket, a menu or pick-list row'],
  ['→  (on a ticket)', 'properties: every setting of the ticket, changeable in place (↑↓ move, → or ⏎ change, ← back)'],
  ['→  (new ticket, tags)', 'tag groups: Model / effort, Tools (standard = the regular Claude Code tools), Other; priority has its own field'],
  ['a  d  (in the tree)', 'add a project (fills the command line) or remove the selected one'],
  ['tab  shift-tab', 'the only keys that move between the three windows: projects, tickets, command line (shift-tab goes back); in the command line tab completes first'],
  ['f  [  ]', 'activity area (tall terminals): f pins or unpins the ticket it follows, [ and ] scroll its output back and forward'],
  ['<  >  (narrow)', 'one pane only: switch project (all projects, then each one)'],
  ['esc', 'clear the filter, close the ticket, or quit'],
  ['q  ctrl-c', 'quit'],
];

export function HelpView({ columns, scopeName }: { columns: number; scopeName: string | null }) {
  const crumbs = [scopeName ?? 'all projects', 'help'];
  const keyW = 26;
  return (
    <Frame columns={columns} header={{ left: titleText(crumbs) }} footer={{ left: st.dim('any key closes help') }}>
      {KEYS.map(([k, a]) => (
        <Text key={k} wrap="truncate-end">
          <Text>{st.text(k.padEnd(keyW)) + st.dim(a)}</Text>
        </Text>
      ))}
    </Frame>
  );
}
