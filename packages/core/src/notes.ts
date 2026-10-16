/** Portable folder metadata. IDs stay stable across moves and exports. */
export interface NoteFolder {
    readonly id: string;
    readonly name: string;
    readonly parentId: string | null;
    readonly revision: number;
    readonly createdAt: string;
    readonly updatedAt: string;
}
export function assertNoteFolders(value: unknown): asserts value is readonly NoteFolder[] {
    if (!Array.isArray(value) || value.length > 10000)
        throw new Error("笔记文件夹数据无效");
    const ids = new Map<string, NoteFolder>();
    const names = new Set<string>();
    for (const folder of value) {
        if (!folder || typeof folder !== "object" || typeof folder.id !== "string" || !folder.id || folder.id.length > 512 || typeof folder.name !== "string" || !folder.name.trim() || folder.name.length > 100 || !(folder.parentId === null || typeof folder.parentId === "string") || !Number.isSafeInteger(folder.revision) || folder.revision < 1 || !Number.isFinite(Date.parse(folder.createdAt)) || !Number.isFinite(Date.parse(folder.updatedAt)))
            throw new Error("笔记文件夹数据无效");
        const key = JSON.stringify([folder.parentId, folder.name.trim()]);
        if (folder.name === '.' || folder.name === '..' || /[\/\\\u0000-\u001f]/.test(folder.name))
            throw new Error('文件夹名称不能含路径分隔符');
        if (ids.has(folder.id) || names.has(key))
            throw new Error("笔记文件夹重复");
        ids.set(folder.id, folder);
        names.add(key);
    }
    for (const folder of value) {
        const seen = new Set([folder.id]);
        let parent = folder.parentId;
        while (parent !== null) {
            if (seen.has(parent))
                throw new Error("文件夹不能循环嵌套");
            seen.add(parent);
            const next = ids.get(parent);
            if (!next)
                throw new Error("上级文件夹不存在");
            parent = next.parentId;
        }
    }
}
