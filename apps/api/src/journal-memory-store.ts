import type { DatabaseSync } from "node:sqlite";

/** Vectors share the record database: tenant/profile isolation and full backups follow it. */
export class JournalMemoryStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS journal_embeddings (
        record_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, content_hash TEXT NOT NULL,
        config_key TEXT NOT NULL, vector BLOB NOT NULL,
        PRIMARY KEY(record_id, chunk_index, config_key)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS journal_embeddings_record_delete AFTER DELETE ON records BEGIN
        DELETE FROM journal_embeddings WHERE record_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS journal_embeddings_record_change AFTER UPDATE ON records
      WHEN NEW.kind != 'journal' OR NEW.is_private = 1 OR NEW.is_demo = 1 OR NEW.deleted_at_json IS NOT NULL
        OR coalesce(NEW.body_edited, NEW.body_original) != coalesce(OLD.body_edited, OLD.body_original)
      BEGIN DELETE FROM journal_embeddings WHERE record_id = OLD.id; END;
    `);
    // Also covers data imported or changed by an earlier application version.
    db.exec(`DELETE FROM journal_embeddings WHERE record_id NOT IN
      (SELECT id FROM records WHERE kind='journal' AND is_private=0 AND is_demo=0 AND deleted_at_json IS NULL)`);
  }
  list(configKey: string): readonly { recordId: string; index: number; hash: string; vector: readonly number[] }[] {
    return this.db.prepare("SELECT * FROM journal_embeddings WHERE config_key=?").all(configKey).flatMap(row => {
      const buffer = row.vector as Uint8Array;
      if (!(buffer instanceof Uint8Array) || buffer.byteLength % 4 !== 0) return [];
      const bytes = Uint8Array.from(buffer);
      const vector = Array.from(new Float32Array(bytes.buffer));
      return [{ recordId: String(row.record_id), index: Number(row.chunk_index), hash: String(row.content_hash), vector }];
    });
  }
  put(recordId: string, index: number, hash: string, configKey: string, vector: readonly number[]): void {
    const bytes = new Float32Array(vector);
    this.db.prepare("INSERT OR REPLACE INTO journal_embeddings(record_id,chunk_index,content_hash,config_key,vector) VALUES(?,?,?,?,?)")
      .run(recordId, index, hash, configKey, Buffer.from(bytes.buffer));
  }
}
