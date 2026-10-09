import { setJson, HttpError } from "./http-kit.js";
import { readBody, readRawBody, requireJsonContentType } from "./http-body.js";
import { booleanField, hasOnlyKeys, jsonObject, stringField } from "./field-validate.js";
import { backfillMaterials, prepareBackfill, requireDraft, saveBackfillPlan, commitBackfill, undoBackfill, deferBackfillItem } from "./assistant-backfill.js";
import { extractMaterialText } from "./assistant-material.js";
import { baseMediaType } from "./asset-static.js";
import { chatBackfill } from "./assistant-conversation.js";
import type { RouteHandler } from "./route-context.js";

export const handleAssistantBackfillRoutes: RouteHandler = async (ctx, req, res, pathname) => {
  const { config, repository } = ctx;
  if (pathname === "/api/ai/backfill/chat" && req.method === "POST") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, Math.max(config.bodyLimitBytes, 18 * 1024 * 1024)), "body");
    hasOnlyKeys(input, ["message", "materials", "history", "batchId", "revision"]);
    setJson(res, 200, await chatBackfill(config, repository, input)); return true;
  }
  if (pathname === "/api/ai/backfill/material-text" && req.method === "POST") {
    const bytes = await readRawBody(req, Math.min(config.assetUploadLimitBytes, 12 * 1024 * 1024));
    setJson(res, 200, { text: await extractMaterialText(bytes, baseMediaType(req.headers["content-type"])) }); return true;
  }
  if (pathname === "/api/ai/backfill" && req.method === "GET") {
    setJson(res, 200, { items: repository.assistantBatches().map(({ beforeEntities: _, afterEntities: __, beforeRecords: ___, afterRecords: ____, ...batch }) => batch) }); return true;
  }
  if (pathname === "/api/ai/backfill/prepare" && req.method === "POST") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, Math.max(config.bodyLimitBytes, 18 * 1024 * 1024)), "body");
    hasOnlyKeys(input, ["materials", "instruction", "batchId", "revision"]);
    const previous = input.batchId === undefined ? undefined : requireDraft(repository, stringField(input.batchId, "batchId"), input.revision);
    const materials = backfillMaterials(input.materials ?? previous?.materials, repository);
    const instruction = input.instruction === undefined ? "" : stringField(input.instruction, "instruction");
    if (instruction.length > 8000) throw new HttpError(400, "instruction_too_long", "修改要求过长，请分次讨论");
    setJson(res, 200, await prepareBackfill(config, repository, materials, instruction, previous)); return true;
  }
  const match = /^\/api\/ai\/backfill\/([a-zA-Z0-9-]+)(?:\/(commit|undo|review))?$/.exec(pathname);
  if (!match) return false;
  const id = match[1]!;
  if (req.method === "GET" && !match[2]) {
    const batch = repository.assistantBatch(id); if (!batch) throw new HttpError(404, "unknown_batch", "找不到这批补记");
    setJson(res, 200, batch); return true;
  }
  if ((req.method === "PATCH" && !match[2]) || (req.method === "POST" && match[2])) {
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, match[2] === "undo" ? [] : match[2] === "review" ? ["revision", "key", "deferred"] : match[2] === "commit" ? ["revision", "keys"] : ["revision", "plan"]);
    const result = match[2] === "review" ? deferBackfillItem(repository, id, input.revision, stringField(input.key, "key"), booleanField(input.deferred, "deferred")) : match[2] === "undo" ? undoBackfill(repository, id) : match[2] === "commit" ? commitBackfill(repository, id, input.revision, input.keys) : saveBackfillPlan(repository, requireDraft(repository, id, input.revision), input.plan);
    setJson(res, 200, result); return true;
  }
  return false;
};
