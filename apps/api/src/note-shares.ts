import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
export interface NoteShare {
    readonly recordId: string;
    readonly token: string;
    readonly passwordHash: string | null;
    readonly secret: string;
    readonly updatedAt: string;
    readonly canEdit?: boolean;
}
/** Access grants are deliberately separate from portable note content. */
export class NoteShares {
    constructor(private readonly db: DatabaseSync) { db.exec('CREATE TABLE IF NOT EXISTS note_shares (record_id TEXT PRIMARY KEY NOT NULL, value_json TEXT NOT NULL)'); }
    get(recordId: string): NoteShare | null { const row = this.db.prepare('SELECT value_json FROM note_shares WHERE record_id=?').get(recordId); return row ? JSON.parse(String(row.value_json)) : null; }
    byToken(token: string): NoteShare | null { const row = this.db.prepare("SELECT value_json FROM note_shares WHERE json_extract(value_json, '$.token')=?").get(token); return row ? JSON.parse(String(row.value_json)) : null; }
    save(recordId: string, passwordHash: string | null, canEdit = this.get(recordId)?.canEdit === true): NoteShare { const old = this.get(recordId); const value: NoteShare = { recordId, token: old?.token ?? randomBytes(32).toString('base64url'), passwordHash, canEdit, secret: old && old.passwordHash === passwordHash ? old.secret : randomBytes(32).toString('hex'), updatedAt: new Date().toISOString() }; this.db.prepare('INSERT INTO note_shares VALUES (?,?) ON CONFLICT(record_id) DO UPDATE SET value_json=excluded.value_json').run(recordId, JSON.stringify(value)); return value; }
    revoke(recordId: string): void { this.db.prepare('DELETE FROM note_shares WHERE record_id=?').run(recordId); }
}
