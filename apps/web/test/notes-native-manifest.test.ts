import test from 'node:test';
import assert from 'node:assert/strict';
import type { NoteFolder, TimelineRecord } from '@lifeos/core';
import { mapNativeNoteFolders, parseNativeNotesManifest } from '../src/notes-native-manifest.ts';

const instant = '2026-10-15T10:00:00.000Z';
function folder(id: string, name: string, parentId: string | null = null): NoteFolder {
    return { id, name, parentId, revision: 1, createdAt: instant, updatedAt: instant };
}
function note(id: string, folderId?: string): TimelineRecord {
    return {
        id,
        kind: 'note',
        body: { original: `body ${id}` },
        createdAt: { kind: 'instant', value: instant },
        entityRefs: [],
        relatedRecordIds: [],
        assetRefs: [],
        aiDerived: [],
        note: { format: 'note', ...(folderId === undefined ? {} : { folderId }) },
    };
}
function manifest(folders: readonly NoteFolder[], records: readonly TimelineRecord[] = []) {
    return { format: 'lifeos.notes', version: 1, folders, records };
}

test('native manifest parser accepts empty records and retains full note records', () => {
    const folders = [folder('folder-1', 'Reading')];
    const records = [note('note-1', 'folder-1')];
    const parsed = parseNativeNotesManifest(manifest(folders, records));
    assert.equal(parsed.format, 'lifeos.notes');
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.folders, folders);
    assert.deepEqual(parsed.records, records);
    assert.deepEqual(parseNativeNotesManifest(manifest(folders)).records, []);
});

test('native manifest parser rejects unsupported envelopes, non-notes, duplicates, and dangling folders', () => {
    const folders = [folder('folder-1', 'Reading')];
    assert.throws(() => parseNativeNotesManifest({ ...manifest(folders), format: 'other' }), /format or version/);
    assert.throws(() => parseNativeNotesManifest({ ...manifest(folders), version: 2 }), /format or version/);
    assert.throws(() => parseNativeNotesManifest({ ...manifest(folders), records: [null] }), /record/);
    const journal: TimelineRecord = {
        id: 'journal',
        kind: 'journal',
        body: { original: 'journal body' },
        createdAt: { kind: 'instant', value: instant },
        entityRefs: [],
        relatedRecordIds: [],
        assetRefs: [],
        aiDerived: [],
    };
    assert.throws(() => parseNativeNotesManifest(manifest(folders, [journal])), /only note records/);
    assert.throws(() => parseNativeNotesManifest(manifest(folders, [note('duplicate'), note('duplicate')])), /Duplicate note record ID/);
    assert.throws(() => parseNativeNotesManifest(manifest(folders, [note('note-1', 'missing')])), /unknown folder/);
    assert.throws(() => parseNativeNotesManifest(manifest(folders, [note('note-1', '')])), /folderId/);
});

test('folder mapper reuses complete target paths and adds only missing folders despite reversed source order', () => {
    const source = [folder('source-leaf', 'New', 'source-child'), folder('source-child', 'Books', 'source-root'), folder('source-root', 'Personal')];
    const current = [folder('target-child', 'Books', 'target-root'), folder('target-root', 'Personal')];
    const mapped = mapNativeNoteFolders(source, current, () => assert.fail('makeId should not be needed'));
    assert.deepEqual(mapped.folders, [folder('source-leaf', 'New', 'target-child')]);
    assert.deepEqual(mapped.idMap, { 'source-leaf': 'source-leaf', 'source-child': 'target-child', 'source-root': 'target-root' });
});

test('folder mapper does not reuse a same-named folder under a different parent path', () => {
    const source = [folder('source-child', 'Books', 'source-root'), folder('source-root', 'Personal')];
    const current = [folder('other-child', 'Books', 'other-root'), folder('other-root', 'Other')];
    const mapped = mapNativeNoteFolders(source, current, () => assert.fail('source IDs are free'));
    assert.deepEqual(mapped.folders, [folder('source-root', 'Personal'), folder('source-child', 'Books', 'source-root')]);
    assert.deepEqual(mapped.idMap, { 'source-child': 'source-child', 'source-root': 'source-root' });
});

test('folder mapper remaps occupied IDs and updates children without colliding with source IDs', () => {
    const sourceRoot = { ...folder('source-root', 'Root'), revision: 4, createdAt: '2025-02-03T04:05:06.000Z', updatedAt: '2025-04-06T07:08:09.000Z' };
    const source = [folder('source-child', 'Child', 'source-root'), sourceRoot];
    const current = [folder('source-root', 'Elsewhere')];
    const generated = ['source-child', 'new-root'];
    let calls = 0;
    const mapped = mapNativeNoteFolders(source, current, () => generated[calls++]!);
    assert.equal(calls, 2);
    assert.deepEqual(mapped.folders, [{ ...sourceRoot, id: 'new-root' }, folder('source-child', 'Child', 'new-root')]);
    assert.deepEqual(mapped.idMap, { 'source-child': 'source-child', 'source-root': 'new-root' });
});

test('folder mapper rejects cycles and duplicate same-name siblings', () => {
    const cycle = [folder('a', 'A', 'b'), folder('b', 'B', 'a')];
    assert.throws(() => mapNativeNoteFolders(cycle, [], () => 'unused'), /cycle|循环/iu);
    const duplicates = [folder('a', 'Same'), folder('b', 'Same')];
    assert.throws(() => mapNativeNoteFolders(duplicates, [], () => 'unused'), /duplicate|重复/iu);
});
