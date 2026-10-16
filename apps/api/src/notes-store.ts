import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { assertNoteFolders, type NoteFolder, type TimelineRecord } from "@lifeos/core";
import { HttpError } from "./http-kit.js";
import { NoteShares } from "./note-shares.js";
export class NotesStore {
    public readonly shares: NoteShares;
    constructor(private readonly db: DatabaseSync) {
        this.shares = new NoteShares(db);
        db.exec(`CREATE TABLE IF NOT EXISTS note_folders (id TEXT PRIMARY KEY NOT NULL, value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS note_versions (id TEXT PRIMARY KEY NOT NULL, record_id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL, UNIQUE(record_id, revision));`);
    }
    list(): NoteFolder[] { return this.db.prepare("SELECT value_json FROM note_folders ORDER BY rowid").all().map(row => JSON.parse(String(row.value_json))); }
    find(id: string): NoteFolder | null { const row = this.db.prepare("SELECT value_json FROM note_folders WHERE id = ?").get(id); return row ? JSON.parse(String(row.value_json)) : null; }
    #validate(folders: readonly NoteFolder[]): void {
        try {
            assertNoteFolders(folders);
        }
        catch (error) {
            throw new HttpError(400, "invalid_folder", (error as Error).message);
        }
    }
    create(name: string, parentId: string | null): NoteFolder {
        const now = new Date().toISOString();
        const folder: NoteFolder = { id: randomUUID(), name: name.trim(), parentId, revision: 1, createdAt: now, updatedAt: now };
        if (this.list().some(item => item.name === folder.name && item.parentId === parentId))
            throw new HttpError(409, "folder_exists", "这里已经有同名文件夹");
        this.#validate([...this.list(), folder]);
        this.db.prepare("INSERT INTO note_folders VALUES (?, ?)").run(folder.id, JSON.stringify(folder));
        return folder;
    }
    update(id: string, revision: number, patch: {
        name?: string;
        parentId?: string | null;
    }): NoteFolder {
        const current = this.find(id);
        if (!current)
            throw new HttpError(404, "not_found", "文件夹不存在");
        if (current.revision !== revision)
            throw new HttpError(409, "revision_conflict", "文件夹已变化，请刷新后重试");
        const folder = { ...current, ...patch, ...(patch.name === undefined ? {} : { name: patch.name.trim() }), revision: revision + 1, updatedAt: new Date().toISOString() };
        const others = this.list().filter(item => item.id !== id);
        if (others.some(item => item.name === folder.name && item.parentId === folder.parentId))
            throw new HttpError(409, "folder_exists", "这里已经有同名文件夹");
        this.#validate([...others, folder]);
        this.db.prepare("UPDATE note_folders SET value_json = ? WHERE id = ?").run(JSON.stringify(folder), id);
        return folder;
    }
    delete(id: string, revision: number): void {
        const folder = this.find(id);
        if (!folder)
            throw new HttpError(404, "not_found", "文件夹不存在");
        if (folder.revision !== revision)
            throw new HttpError(409, "revision_conflict", "文件夹已变化，请刷新后重试");
        if (this.list().some(item => item.parentId === id) || this.db.prepare("SELECT id FROM records WHERE deleted_at_json IS NULL AND kind = 'note' AND json_extract(note_json, '$.folderId') = ? LIMIT 1").get(id))
            throw new HttpError(409, "folder_not_empty", "请先移走笔记和子文件夹，再删除这个文件夹");
        this.db.prepare("DELETE FROM note_folders WHERE id = ?").run(id);
        // Deleted notes remain restorable, without a dangling folder assignment.
        this.db.prepare("UPDATE records SET note_json = json_remove(note_json, '$.folderId') WHERE kind = 'note' AND json_extract(note_json, '$.folderId') = ?").run(id);
    }
    assertFolder(record: TimelineRecord): void {
        if (record.kind === "note" && record.note?.folderId && !this.find(record.note.folderId))
            throw new HttpError(400, "unknown_folder", "笔记文件夹不存在");
    }
    importFolders(folders: readonly NoteFolder[]): void {
        if (!folders.length)
            return;
        const existing = this.list();
        if (folders.some(folder => existing.some(item => item.id === folder.id)))
            throw new HttpError(409, "folder_exists", "导入的文件夹已存在");
        this.#validate([...existing, ...folders]);
        const insert = this.db.prepare("INSERT INTO note_folders VALUES (?, ?)");
        for (const folder of folders)
            insert.run(folder.id, JSON.stringify(folder));
    }
    capture(record: TimelineRecord & {
        revision: number;
    }): void {
        if (record.kind !== "note")
            return;
        this.db.prepare("INSERT OR IGNORE INTO note_versions VALUES (?, ?, ?, ?, ?)").run(randomUUID(), record.id, record.revision, new Date().toISOString(), JSON.stringify(record));
    }
    versions(id: string): unknown[] {
        return this.db.prepare("SELECT * FROM note_versions WHERE record_id = ? ORDER BY revision DESC").all(id).map(row => ({ id: row.id, revision: row.revision, createdAt: row.created_at, record: JSON.parse(String(row.record_json)) }));
    }
}
