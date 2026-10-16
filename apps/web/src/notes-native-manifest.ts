import {
    assertNoteFolders,
    assertValidTimelineRecord,
    type NoteFolder,
    type TimelineRecord,
} from '@lifeos/core';

export interface NativeNotesManifest {
    readonly format: 'lifeos.notes';
    readonly version: 1;
    readonly folders: readonly NoteFolder[];
    readonly records: readonly TimelineRecord[];
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${name} must be an object`);
    return value as Record<string, unknown>;
}

export function parseNativeNotesManifest(value: unknown): NativeNotesManifest {
    const manifest = objectValue(value, 'manifest');
    if (manifest.format !== 'lifeos.notes' || manifest.version !== 1)
        throw new Error('Unsupported native notes manifest format or version');

    const foldersValue = manifest.folders;
    assertNoteFolders(foldersValue);
    if (!Array.isArray(manifest.records))
        throw new Error('manifest.records must be an array');

    const folderIds = new Set(foldersValue.map(folder => folder.id));
    const recordIds = new Set<string>();
    const records: TimelineRecord[] = [];
    for (const rawRecord of manifest.records) {
        assertValidTimelineRecord(rawRecord);
        if (rawRecord.kind !== 'note')
            throw new Error('Native notes manifests may contain only note records');
        if (recordIds.has(rawRecord.id))
            throw new Error(`Duplicate note record ID: ${rawRecord.id}`);
        recordIds.add(rawRecord.id);
        if (rawRecord.note?.folderId !== undefined && !folderIds.has(rawRecord.note.folderId))
            throw new Error(`Note ${rawRecord.id} references an unknown folder`);
        records.push(rawRecord);
    }

    return {
        format: 'lifeos.notes',
        version: 1,
        folders: [...foldersValue],
        records,
    };
}

function pathKey(path: readonly string[]): string {
    return JSON.stringify(path);
}

function folderPath(id: string, byId: ReadonlyMap<string, NoteFolder>, cache: Map<string, readonly string[]>): readonly string[] {
    const cached = cache.get(id);
    if (cached)
        return cached;

    const pending: NoteFolder[] = [];
    let currentId = id;
    while (!cache.has(currentId)) {
        const folder = byId.get(currentId);
        if (!folder)
            throw new Error(`Folder parent does not exist: ${currentId}`);
        pending.push(folder);
        if (folder.parentId === null)
            break;
        currentId = folder.parentId;
    }

    for (let index = pending.length - 1; index >= 0; index--) {
        const folder = pending[index]!;
        const parentPath = folder.parentId === null ? [] : cache.get(folder.parentId);
        if (parentPath === undefined)
            throw new Error(`Folder parent does not exist: ${folder.parentId}`);
        cache.set(folder.id, [...parentPath, folder.name]);
    }
    return cache.get(id)!;
}

export function mapNativeNoteFolders(
    sourceFolders: readonly NoteFolder[],
    currentFolders: readonly NoteFolder[],
    makeId: () => string,
): { folders: NoteFolder[]; idMap: Record<string, string> } {
    assertNoteFolders(sourceFolders);
    assertNoteFolders(currentFolders);

    const sourceById = new Map(sourceFolders.map(folder => [folder.id, folder]));
    const currentById = new Map(currentFolders.map(folder => [folder.id, folder]));
    const sourcePathCache = new Map<string, readonly string[]>();
    const currentPathCache = new Map<string, readonly string[]>();
    const currentByPath = new Map<string, NoteFolder>();
    for (const folder of currentFolders)
        currentByPath.set(pathKey(folderPath(folder.id, currentById, currentPathCache)), folder);

    const mappedIds = new Map<string, string>();
    const additions: NoteFolder[] = [];
    const reservedIds = new Set([...sourceById.keys(), ...currentById.keys()]);

    const allocateId = (): string => {
        for (let attempt = 0; attempt < 1000; attempt++) {
            const id = makeId();
            if (typeof id !== 'string' || !id.trim())
                throw new Error('Folder ID generator returned an empty ID');
            if (!reservedIds.has(id)) {
                reservedIds.add(id);
                return id;
            }
        }
        throw new Error('Folder ID generator did not produce a unique ID');
    };

    const orderedSourceFolders = [...sourceFolders].sort((left, right) =>
        folderPath(left.id, sourceById, sourcePathCache).length - folderPath(right.id, sourceById, sourcePathCache).length,
    );
    for (const folder of orderedSourceFolders) {
        const path = folderPath(folder.id, sourceById, sourcePathCache);
        const matchingFolder = currentByPath.get(pathKey(path));
        if (matchingFolder) {
            mappedIds.set(folder.id, matchingFolder.id);
            continue;
        }

        const parentId = folder.parentId === null ? null : mappedIds.get(folder.parentId);
        if (parentId === undefined)
            throw new Error(`Folder parent was not mapped: ${folder.parentId}`);
        const id = currentById.has(folder.id) ? allocateId() : folder.id;
        reservedIds.add(id);
        additions.push({ ...folder, id, parentId });
        mappedIds.set(folder.id, id);
    }

    assertNoteFolders([...currentFolders, ...additions]);
    const idMap = Object.fromEntries(sourceFolders.map(folder => [folder.id, mappedIds.get(folder.id)!])) as Record<string, string>;
    return { folders: additions, idMap };
}
