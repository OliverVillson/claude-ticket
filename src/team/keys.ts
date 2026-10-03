import type { Database } from 'bun:sqlite';
import { CliError } from '../core/errors.ts';
import { memberSigOk, newMemberToken, remoteKey, signatureOk, type Verifier } from '../sync/format.ts';
import { getMember } from './store.ts';

/**
 * Per-person signing keys, kept on the box (the one place that checks them). One key per member: issuing a
 * new one replaces the old, removing the member or revoking drops it. The secret is stored as is because the
 * box has to recompute the signature; it sits in the box's database like the shared key sits in its key file.
 */
export interface KeyInfo {
  member: string;
  kid: string;
  created_at: number;
}

/** Make (or replace) a member's key. The token is shown once; give it to them out of band. */
export function issueKey(db: Database, projectId: number, name: string): { member: string; kid: string; token: string } {
  const m = getMember(db, projectId, name);
  if (!m) throw new CliError(`${name} is not on this project: salu team add ${name}`);
  const k = newMemberToken();
  db.query('INSERT INTO member_keys (member_id, kid, secret, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET kid = excluded.kid, secret = excluded.secret, created_at = excluded.created_at').run(m.id, k.kid, k.secret, Date.now());
  return { member: m.name, kid: k.kid, token: k.token };
}

export function revokeKey(db: Database, projectId: number, name: string): boolean {
  const m = getMember(db, projectId, name);
  if (!m) throw new CliError(`${name} is not on this project`);
  return db.query('DELETE FROM member_keys WHERE member_id = ?').run(m.id).changes > 0;
}

export function listKeys(db: Database, projectId: number): KeyInfo[] {
  return db.query<KeyInfo, [number]>('SELECT m.name AS member, k.kid, k.created_at FROM member_keys k JOIN members m ON m.id = k.member_id WHERE m.project_id = ? ORDER BY m.id').all(projectId);
}

/** The keys the box signs its messages for. */
export function activeKeys(db: Database, projectId: number): Array<{ kid: string; secret: string }> {
  return db.query<{ kid: string; secret: string }, [number]>('SELECT k.kid, k.secret FROM member_keys k JOIN members m ON m.id = k.member_id WHERE m.project_id = ?').all(projectId);
}

export function sharedKeyRetired(db: Database, projectId: number): boolean {
  return !!db.query<{ shared_retired: number }, [number]>('SELECT shared_retired FROM team_settings WHERE project_id = ?').get(projectId)?.shared_retired;
}

/** The admin stops accepting the old shared key for this project (or lets it back in). */
export function setSharedRetired(db: Database, projectId: number, retired: boolean): void {
  db.query('INSERT INTO team_settings (project_id, shared_retired) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET shared_retired = excluded.shared_retired').run(projectId, retired ? 1 : 0);
}

/**
 * Box: check a file from a client. A file naming a key (`kid`) must verify under that member's current key of
 * this project, and then it is theirs; an unknown or revoked key is refused, never retried with the shared key.
 * A file without `kid` is checked against the shared key as in v1, until the admin retires it.
 */
export function boxVerifier(db: Database, projectId: number): Verifier {
  return (o) => {
    if (o && typeof o === 'object' && o.kid !== undefined) {
      if (typeof o.kid !== 'string' || !/^[0-9a-f]{8}$/.test(o.kid)) return { ok: false };
      const row = db.query<{ secret: string; name: string }, [string, number]>('SELECT k.secret, m.name FROM member_keys k JOIN members m ON m.id = k.member_id WHERE k.kid = ? AND m.project_id = ?').get(o.kid, projectId);
      return row && memberSigOk(o, row.secret) ? { ok: true, by: row.name } : { ok: false };
    }
    if (sharedKeyRetired(db, projectId)) return { ok: false };
    return { ok: signatureOk(o, remoteKey()) };
  };
}
