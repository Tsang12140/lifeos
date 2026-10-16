import type { RouteHandler } from "./route-context.js";
import { HttpError, setEmpty, setJson } from "./http-kit.js";
import { readBody, requireJsonContentType } from "./http-body.js";
import { hasOnlyKeys, jsonObject, revisionField, stringField } from "./field-validate.js";
import { relatedRecordIdsField } from "./record-builders.js";
export const handleNotesRoutes: RouteHandler = async ({ repository, config }, req, res, pathname, url) => {
    const store = repository.notes;
    if(pathname==="/api/notes/import-links"&&req.method==="POST") {
        requireJsonContentType(req);const input=jsonObject(await readBody(req,config.bodyLimitBytes),"body");hasOnlyKeys(input,["records"]);
        if(!Array.isArray(input.records)||input.records.length>1000)throw new HttpError(400,"invalid_links","笔记关联清单无效");
        const records=input.records;
        const items=repository.atomic(()=>records.map((raw:unknown)=>{const item=jsonObject(raw,"record");hasOnlyKeys(item,["id","revision","relatedRecordIds"]);const id=stringField(item.id,"id"),current=repository.findById(id);if(current?.kind!=="note")throw new HttpError(404,"not_found","笔记不存在");const relatedRecordIds=relatedRecordIdsField(item.relatedRecordIds,id,repository);if(!repository.update({...current,relatedRecordIds},revisionField(item.revision)))throw new HttpError(409,"revision_conflict","笔记已变化，未覆盖关联");return repository.findById(id)!;}));
        setJson(res,200,{items});return true;
    }
    if (pathname === "/api/note-folders" && req.method === "GET") {
        setJson(res, 200, { folders: store.list() });
        return true;
    }
    const folderMatch = /^\/api\/note-folders\/([^/]+)$/.exec(pathname);
    const versions = /^\/api\/notes\/([^/]+)\/versions$/.exec(pathname);
    if (versions && req.method === "GET") {
        const id = decodeURIComponent(versions[1]!);
        if (repository.findById(id)?.kind !== "note")
            throw new HttpError(404, "not_found", "笔记不存在");
        setJson(res, 200, { versions: store.versions(id) });
        return true;
    }
    if (folderMatch && req.method === "DELETE") {
        store.delete(decodeURIComponent(folderMatch[1]!), revisionField(Number(url.searchParams.get("revision"))));
        setEmpty(res, 204);
        return true;
    }
    if (!((pathname === "/api/note-folders" && req.method === "POST") || (folderMatch && req.method === "PATCH")))
        return false;
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, req.method === "POST" ? ["name", "parentId"] : ["revision", "name", "parentId"]);
    const parentId = input.parentId === undefined ? undefined : input.parentId === null ? null : stringField(input.parentId, "parentId");
    const name = input.name === undefined ? undefined : stringField(input.name, "name");
    if (req.method === "POST") {
        if (name === undefined)
            throw new HttpError(400, "invalid_folder", "请填写文件夹名称");
        setJson(res, 201, { folder: store.create(name, parentId ?? null) });
    }
    else
        setJson(res, 200, { folder: store.update(decodeURIComponent(folderMatch![1]!), revisionField(input.revision), { ...(name === undefined ? {} : { name }), ...(parentId === undefined ? {} : { parentId }) }) });
    return true;
};
