import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { resolveProject } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { bold, dim, green } from '../../core/ansi.ts';
import { SEAT_PLANS, addMember, addSeat, listMembers, listSeats, removeMember, removeSeat, setLend, setRole, setSeatDisabled, type Role, type SeatPlan } from '../../team/store.ts';
import { TERMS_WARNING, lendLog, requireLender } from '../../team/lend.ts';
import { confirm, helpIf } from './_shared.ts';

const TEAM_HELP = `salu team [list] [--project P] [--json]       who is on the project and who owns it
salu team add <name> [--admin]                 add a person (the first person added owns the project)
salu team role <name> admin|member             change someone's role (a project always keeps one admin)
salu team rm <name> [--yes]                    take someone off; their seats are switched off

The admin owns the project and the box. Members add tickets and reply. This is the roster only: it does
not yet sign, restrict or schedule anything, so a project without a team runs exactly as before.`;

const SEAT_HELP = `salu seat [list] [--project P] [--json]       the Claude seats this project can run tickets on
salu seat add <label> [--owner <name>] [--plan team|enterprise|pro|max|api|other]
                                                 register a seat (one Team or Enterprise seat per person)
salu seat rm <label> [--yes]                     forget a seat
salu seat off|on <label>                         switch a seat off or back on
salu seat lend <label> on|off [--cap N] [--from H --to H]
                                                 let teammates' tickets use this seat's spare time. Off until the
                                                 seat's owner turns it on (it checks SALU_USER against the owner's
                                                 name, a guard against slips, not a lock). N = most percent of the
                                                 5-hour window others may use; H = hours 0-23 the lending is open
salu seat lent [--project P] [--json]            every borrowed ticket: lender, borrower, expected and actual cost

A seat is a name for a login; it holds no secret. TERMS NOT CHECKED: whether a subscription seat may serve a
teammate's ticket has not been checked at the source. Lending is the lender's choice and responsibility: read
the plan's terms before turning it on.`;


function project(p: Parsed) {
  return resolveProject(openDb(), flagStr(p, 'project'));
}

function table(rows: string[][]): string {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join('  ').trimEnd()).join('\n');
}

export async function team(p: Parsed): Promise<number> {
  if (helpIf(p, TEAM_HELP)) return 0;
  const db = openDb();
  const proj = project(p);
  const [sub = 'list', a, b] = p.positional;
  switch (sub) {
    case 'list':
    case 'ls': {
      const members = listMembers(db, proj.id);
      if (flagBool(p, 'json')) {
        console.log(JSON.stringify(members, null, 2));
        return 0;
      }
      if (!members.length) {
        console.log(`${proj.name} has no team yet. Add the first person (they will own the project): salu team add <name>`);
        return 0;
      }
      console.log(bold(`${proj.name} team`));
      console.log(table(members.map((m) => [m.name, m.role])));
      return 0;
    }
    case 'add': {
      if (!a) throw new CliError('usage: salu team add <name> [--admin]');
      const m = addMember(db, proj.id, a, flagBool(p, 'admin') ? 'admin' : 'member');
      console.log(`${green('✓')} ${m.name} is ${m.role === 'admin' ? 'an admin' : 'a member'} of ${proj.name}`);
      return 0;
    }
    case 'role': {
      if (!a || !b) throw new CliError('usage: salu team role <name> admin|member');
      const m = setRole(db, proj.id, a, b as Role);
      console.log(`${green('✓')} ${m.name} is now ${m.role === 'admin' ? 'an admin' : 'a member'}`);
      return 0;
    }
    case 'rm':
    case 'remove': {
      if (!a) throw new CliError('usage: salu team rm <name> [--yes]');
      if (!(await confirm(p, `Take ${a} off ${proj.name}? Their seats are switched off.`))) return 1;
      const m = removeMember(db, proj.id, a);
      console.log(`${green('✓')} ${m.name} is off ${proj.name}`);
      return 0;
    }
    default:
      throw new CliError(`unknown: salu team ${sub}\n\n${TEAM_HELP}`);
  }
}

export async function seat(p: Parsed): Promise<number> {
  if (helpIf(p, SEAT_HELP)) return 0;
  const db = openDb();
  const proj = project(p);
  const [sub = 'list', a, b] = p.positional;
  switch (sub) {
    case 'list':
    case 'ls': {
      const seats = listSeats(db, proj.id);
      if (flagBool(p, 'json')) {
        console.log(JSON.stringify(seats, null, 2));
        return 0;
      }
      if (!seats.length) {
        console.log(`${proj.name} has no seats registered. Add one: salu seat add <label> --owner <name>`);
        return 0;
      }
      console.log(bold(`${proj.name} seats`));
      console.log(table([['seat', 'owner', 'plan', 'lending'], ...seats.map((s) => [s.label, s.owner ?? dim('(left)'), s.plan, s.disabled ? 'off' : s.lend ? `yes, up to ${s.lend_cap_pct ?? 50}%${s.lend_from != null ? `, ${s.lend_from}-${s.lend_to}h` : ''}` : 'no'])]));
      return 0;
    }
    case 'add': {
      if (!a) throw new CliError('usage: salu seat add <label> [--owner <name>] [--plan team|enterprise|pro|max|api|other]');
      const plan = flagStr(p, 'plan');
      if (plan && !SEAT_PLANS.includes(plan as SeatPlan)) throw new CliError(`plan is one of ${SEAT_PLANS.join(', ')}`);
      const s = addSeat(db, proj.id, a, { owner: flagStr(p, 'owner'), plan: plan as SeatPlan | undefined });
      console.log(`${green('✓')} seat "${s.label}" added${s.owner ? ` for ${s.owner}` : ''}`);
      return 0;
    }
    case 'rm':
    case 'remove': {
      if (!a) throw new CliError('usage: salu seat rm <label> [--yes]');
      if (!(await confirm(p, `Forget seat "${a}"?`))) return 1;
      console.log(`${green('✓')} seat "${removeSeat(db, proj.id, a).label}" forgotten`);
      return 0;
    }
    case 'off':
    case 'on': {
      if (!a) throw new CliError(`usage: salu seat ${sub} <label>`);
      const s = setSeatDisabled(db, proj.id, a, sub === 'off');
      console.log(`${green('✓')} seat "${s.label}" is ${sub}`);
      return 0;
    }
    case 'lend': {
      if (!a || (b !== 'on' && b !== 'off')) throw new CliError('usage: salu seat lend <label> on|off [--cap N] [--from H --to H]');
      requireLender(db, proj.id, a, b === 'on');
      const num = (k: string) => (flagStr(p, k) != null ? Number(flagStr(p, k)) : undefined);
      const s = setLend(db, proj.id, a, b === 'on', { cap: num('cap'), from: num('from'), to: num('to') });
      if (s.lend) {
        console.log(`${green('✓')} seat "${s.label}" lends up to ${s.lend_cap_pct}% of its 5-hour window${s.lend_from != null ? `, ${s.lend_from}:00 to ${s.lend_to}:00` : ', any hour'}`);
        console.log(`\n${TERMS_WARNING}`);
      } else console.log(`${green('✓')} seat "${s.label}" no longer lends`);
      return 0;
    }
    case 'lent': {
      const rows = lendLog(db, proj.id);
      if (flagBool(p, 'json')) {
        console.log(JSON.stringify(rows, null, 2));
        return 0;
      }
      if (!rows.length) {
        console.log('No ticket has borrowed a teammate\'s seat on this project.');
        return 0;
      }
      const usd = (n: number) => `$${n.toFixed(2)}`;
      console.log(table([['when', 'ticket', 'lender', 'borrower', 'seat', 'expected', 'cost so far'], ...rows.map((r) => [new Date(r.at).toISOString().slice(0, 16).replace('T', ' '), r.ticket, r.lender ?? '(left)', r.borrower, r.seat, `${Math.round(r.est_pct)}% / ${usd(r.est_usd)}`, usd(r.cost_usd)])]));
      return 0;
    }
    default:
      throw new CliError(`unknown: salu seat ${sub}\n\n${SEAT_HELP}`);
  }
}
