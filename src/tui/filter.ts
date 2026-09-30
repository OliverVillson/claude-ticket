import type { TicketStatus, TicketView } from '../db/types.ts';
import { TICKET_STATUSES, ticketLabels, ticketTags } from '../db/types.ts';

/**
 * The `/` filter language. Plain words match anywhere (name, query, labels, status, project,
 * tag values); prefixed terms narrow one field. Terms are ANDed; `-term` negates.
 *
 *   bug               name/query/labels/... contains "bug"
 *   #bug  label:bug   has the label
 *   status:running  s:running  running   (a bare status word also matches the status)
 *   p1  priority:1  p:1  pnow  p0        priority 1, or 0 ("run now")
 *   p<=2  p>=3                           priority ranges
 *   @web  project:web                    project name contains "web"
 *   model:opus  effort:high  key:value   a tag
 *   -done                                exclude
 */
export interface FilterTerm {
  kind: 'text' | 'status' | 'priority' | 'label' | 'project' | 'tag';
  key?: string;
  value: string;
  op?: '=' | '<=' | '>=' | '<' | '>';
  negate: boolean;
}

export function parseFilter(query: string): FilterTerm[] {
  const terms: FilterTerm[] = [];
  for (let raw of query.trim().split(/\s+/)) {
    if (!raw) continue;
    let negate = false;
    if (raw.startsWith('-') && raw.length > 1) {
      negate = true;
      raw = raw.slice(1);
    }
    const lower = raw.toLowerCase();
    if (lower.startsWith('#') && lower.length > 1) {
      terms.push({ kind: 'label', value: lower.slice(1), negate });
      continue;
    }
    if (lower.startsWith('@') && lower.length > 1) {
      terms.push({ kind: 'project', value: lower.slice(1), negate });
      continue;
    }
    const pm = /^p(?:riority)?(<=|>=|<|>|:|=)?([0-5]|now)$/.exec(lower);
    if (pm) {
      const op = pm[1] === ':' || pm[1] === '=' || !pm[1] ? '=' : (pm[1] as FilterTerm['op']);
      terms.push({ kind: 'priority', value: pm[2] === 'now' ? '0' : pm[2]!, op, negate });
      continue;
    }
    const colon = lower.indexOf(':');
    if (colon > 0 && colon < lower.length - 1) {
      const key = lower.slice(0, colon);
      const value = lower.slice(colon + 1);
      if (key === 'status' || key === 's') {
        terms.push({ kind: 'status', value, negate });
        continue;
      }
      if (key === 'label' || key === 'l') {
        terms.push({ kind: 'label', value, negate });
        continue;
      }
      if (key === 'project' || key === 'proj') {
        terms.push({ kind: 'project', value, negate });
        continue;
      }
      if (key === 'priority' || key === 'p') {
        terms.push({ kind: 'priority', value: value === 'now' ? '0' : value, op: '=', negate });
        continue;
      }
      terms.push({ kind: 'tag', key, value, negate });
      continue;
    }
    terms.push({ kind: 'text', value: lower, negate });
  }
  return terms;
}

function statusMatches(status: TicketStatus, value: string): boolean {
  return status.startsWith(value);
}

export function matchesFilter(t: TicketView, terms: FilterTerm[]): boolean {
  if (terms.length === 0) return true;
  let labels: string[] | null = null;
  let tags: Record<string, string> | null = null;
  let haystack: string | null = null;
  for (const term of terms) {
    let hit: boolean;
    switch (term.kind) {
      case 'status':
        hit = statusMatches(t.status, term.value);
        break;
      case 'priority': {
        const n = Number(term.value);
        const p = t.priority;
        hit =
          term.op === '<=' ? p <= n : term.op === '>=' ? p >= n : term.op === '<' ? p < n : term.op === '>' ? p > n : p === n;
        break;
      }
      case 'label':
        labels ??= ticketLabels(t).map((l) => l.toLowerCase());
        hit = labels.some((l) => l.includes(term.value));
        break;
      case 'project':
        hit = t.project.toLowerCase().includes(term.value);
        break;
      case 'tag': {
        tags ??= ticketTags(t);
        const v = tags[term.key!];
        hit = v != null && String(v).toLowerCase().includes(term.value);
        break;
      }
      default: {
        if (haystack === null) {
          labels ??= ticketLabels(t).map((l) => l.toLowerCase());
          tags ??= ticketTags(t);
          haystack = [t.name, t.query, t.project, t.status, ...labels, ...Object.values(tags).map(String)]
            .join('\n')
            .toLowerCase();
        }
        hit =
          haystack.includes(term.value) ||
          (TICKET_STATUSES as string[]).some((s) => s === term.value && t.status === s);
      }
    }
    if (term.negate ? hit : !hit) return false;
  }
  return true;
}

export function applyFilter(tickets: TicketView[], query: string): TicketView[] {
  const terms = parseFilter(query);
  if (terms.length === 0) return tickets;
  return tickets.filter((t) => matchesFilter(t, terms));
}
