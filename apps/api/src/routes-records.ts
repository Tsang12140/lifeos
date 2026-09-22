import type { IncomingMessage, ServerResponse } from "node:http";
import type { RecordKind, TaskStatus } from "@lifeos/core";
import { ConflictError } from "./repository.js";
import { HttpError, setJson, setEmpty } from "./http-kit.js";
import { readBody, requireJsonContentType } from "./http-body.js";
import {
  booleanField,
  enumField,
  hasOnlyKeys,
  jsonObject,
  parseDateQuery,
  parseLifeTime,
  parseNoteDetails,
  revisionField,
  stringField,
} from "./field-validate.js";
import { assertImportReferences, buildRecord, contentDisposition, patchRecord, safeId } from "./record-builders.js";
import { nowInstant } from "./field-validate.js";
import { assertTimeZone, datesBetween, filterDate, filterDateRange, sortTimeline } from "./timeline-query.js";
import { buildManualDaySummary, createDaySummaryProvider, resolveDaySummaries } from "./summary.js";
import {
  createExportBundle,
  exportRecordMarkdown,
  parseExportJson,
  serializeExportJson,
  type DaySummary,
} from "@lifeos/core";
import { collectSummarisableRecords, summaryPayload } from "./summary-routes.js";
import type { RouteContext, RouteHandler } from "./route-context.js";

const RECORD_KINDS: readonly RecordKind[] = ["journal", "task", "event", "note"];
const TASK_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "done", "cancelled"];

export const handleRecordsRoutes: RouteHandler = async (
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> => {
  const { config, repository } = ctx;
  if (pathname === "/api/records" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? undefined;
    if (q !== undefined && q.length > 2000) throw new HttpError(400, "invalid_query", "q is too long");
    const kindRaw = url.searchParams.get("kind");
    const statusRaw = url.searchParams.get("status");
    const kind = kindRaw === null || kindRaw === "" ? undefined : enumField(kindRaw, RECORD_KINDS, "kind");
    const status = statusRaw === null || statusRaw === "" ? undefined : enumField(statusRaw, TASK_STATUSES, "status");
    const date = parseDateQuery(url.searchParams.get("date"), "date");
    const from = parseDateQuery(url.searchParams.get("from"), "from");
    const to = parseDateQuery(url.searchParams.get("to"), "to");
    if (date !== undefined && (from !== undefined || to !== undefined)) {
      throw new HttpError(400, "invalid_range", "date cannot be combined with from/to");
    }
    if (from !== undefined && to !== undefined && from > to) {
      throw new HttpError(400, "invalid_range", "from must not be after to");
    }
    const timeZone = url.searchParams.get("timeZone") || "UTC";
    // The range is applied in memory, so it is kept to a size a calendar can ask for.
    if (from !== undefined && to !== undefined && datesBetween(from, to).length > 400) {
      throw new HttpError(400, "invalid_range", "range must not exceed 400 days");
    }
    const entityId = url.searchParams.get("entityId") || undefined;
    const assetId = url.searchParams.get("assetId") || undefined;
    const query: { q?: string; kind?: RecordKind; status?: TaskStatus; entityId?: string; assetId?: string } = {};
    if (q !== undefined) query.q = q;
    if (kind !== undefined) query.kind = kind;
    if (status !== undefined) query.status = status;
    if (entityId !== undefined) query.entityId = entityId;
    if (assetId !== undefined) query.assetId = assetId;
    // Date/range reads feed Today and Calendar. Notes are a separate content
    // library and must not leak into those time-oriented surfaces.
    const timeScoped = date !== undefined || from !== undefined || to !== undefined;
    const sourceRecords = repository.list(query).filter((record) => !(timeScoped && record.kind === "note"));
    const scoped = filterDate(sourceRecords, date, timeZone);
    const items = sortTimeline(filterDateRange(scoped, from, to, timeZone), timeZone);
    setJson(res, 200, { items });
    return true;
  }
  if (pathname === "/api/summaries" && req.method === "GET") {
    const from = parseDateQuery(url.searchParams.get("from"), "from");
    const to = parseDateQuery(url.searchParams.get("to"), "to");
    if (from === undefined || to === undefined) throw new HttpError(400, "invalid_range", "from and to are required");
    if (from > to) throw new HttpError(400, "invalid_range", "from must not be after to");
    const timeZone = url.searchParams.get("timeZone") || "UTC";
    assertTimeZone(timeZone);
    const dates = datesBetween(from, to);
    if (dates.length > 400) throw new HttpError(400, "invalid_range", "range must not exceed 400 days");
    const byDate = collectSummarisableRecords(repository, timeZone);
    // Resolved per request, not per process: the AI key lives in the settings
    // file, so reading it here is what makes "save the key, reopen the calendar"
    // work without restarting the API.
    const daySummaryProvider = createDaySummaryProvider(config);
    const items = await resolveDaySummaries({
      dates,
      recordsForDate: (date) => byDate.get(date) ?? [],
      cache: repository,
      provider: daySummaryProvider,
      force: url.searchParams.get("force") === "1",
    });
    setJson(res, 200, summaryPayload(items, daySummaryProvider));
    return true;
  }
  if (pathname === "/api/summaries/manual" && req.method === "POST") {
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["entries", "timeZone"]);
    const entries = Array.isArray(input.entries) ? input.entries : null;
    if (entries === null) throw new HttpError(400, "invalid_entries", "entries must be an array");
    if (entries.length > 400) throw new HttpError(400, "invalid_entries", "entries must not exceed 400 items");
    const timeZone = typeof input.timeZone === "string" ? input.timeZone : "UTC";
    assertTimeZone(timeZone);
    const byDate = collectSummarisableRecords(repository, timeZone);
    const saved: DaySummary[] = [];
    const cleared: string[] = [];
    for (const entry of entries) {
      const item = jsonObject(entry, "entries[]");
      hasOnlyKeys(item, ["date", "text"]);
      const date = stringField(item.date, "date", { nonEmpty: true });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "invalid_date", `entries[].date must be YYYY-MM-DD, received ${date}`);
      const text = stringField(item.text, "text");
      // An emptied field is a revert, not a blank summary: the row is dropped so
      // the next read recomputes it from the records.
      if (text.trim() === "") {
        repository.deleteDaySummary(date);
        cleared.push(date);
        continue;
      }
      const summary = buildManualDaySummary(date, text, byDate.get(date) ?? []);
      repository.writeDaySummary(summary);
      saved.push(summary);
    }
    setJson(res, 200, { items: saved, cleared });
    return true;
  }
  if (pathname === "/api/summaries/regenerate" && req.method === "POST") {
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["date", "from", "to", "timeZone"]);
    const single = input.date === undefined ? undefined : parseDateQuery(stringField(input.date, "date", { nonEmpty: true }), "date");
    let from = single;
    let to = single;
    if (single === undefined) {
      if (input.from === undefined || input.to === undefined) throw new HttpError(400, "invalid_range", "date, or both from and to, are required");
      from = parseDateQuery(stringField(input.from, "from", { nonEmpty: true }), "from");
      to = parseDateQuery(stringField(input.to, "to", { nonEmpty: true }), "to");
    }
    if (from === undefined || to === undefined) throw new HttpError(400, "invalid_range", "date, or both from and to, are required");
    if (from > to) throw new HttpError(400, "invalid_range", "from must not be after to");
    const timeZone = typeof input.timeZone === "string" ? input.timeZone : "UTC";
    assertTimeZone(timeZone);
    const dates = datesBetween(from, to);
    if (dates.length > 400) throw new HttpError(400, "invalid_range", "range must not exceed 400 days");
    const byDate = collectSummarisableRecords(repository, timeZone);
    const daySummaryProvider = createDaySummaryProvider(config);
    // Forcing is what makes this a regenerate rather than a read: it steps over
    // the cached row — including one the owner typed — and writes a fresh one.
    const items = await resolveDaySummaries({
      dates,
      recordsForDate: (date) => byDate.get(date) ?? [],
      cache: repository,
      provider: daySummaryProvider,
      force: true,
    });
    setJson(res, 200, summaryPayload(items, daySummaryProvider));
    return true;
  }
  if (pathname === "/api/records" && req.method === "POST") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    const record = buildRecord(input, repository);
    repository.insert(record);
    const view = repository.findById(record.id);
    if (view === null) throw new Error("Inserted record could not be read back");
    setJson(res, 201, view);
    return true;
  }
  const recordMatch = /^\/api\/records\/([^/]+)$/.exec(pathname);
  if (recordMatch !== null && (req.method === "PATCH" || req.method === "DELETE")) {
    let decodedId: string;
    try {
      decodedId = decodeURIComponent(recordMatch[1]!);
    } catch {
      throw new HttpError(400, "invalid_id", "Invalid record id");
    }
    const id = safeId(decodedId);
    requireJsonContentType(req);
    const current = repository.findById(id);
    if (current === null) throw new HttpError(404, "not_found", "Record not found");
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    if (req.method === "DELETE") {
      hasOnlyKeys(input, ["revision"]);
      const revision = revisionField(input.revision);
      if (!repository.softDelete(id, revision, JSON.stringify(nowInstant()))) {
        const latest = repository.findById(id);
        if (latest === null) throw new HttpError(404, "not_found", "Record not found");
        throw new HttpError(409, "revision_conflict", "Record was changed; reload before deleting");
      }
      setEmpty(res, 204);
      return true;
    }
    const patched = patchRecord(current, input, repository);
    if (!repository.update(patched.record, patched.expectedRevision)) {
      const latest = repository.findById(id);
      if (latest === null) throw new HttpError(404, "not_found", "Record not found");
      setJson(res, 409, { error: "revision_conflict", message: "Record was changed; reload before editing", current: latest });
      return true;
    }
    const updated = repository.findById(id);
    if (updated === null) throw new Error("Updated record could not be read back");
    setJson(res, 200, updated);
    return true;
  }
  if (pathname === "/api/export" && req.method === "GET") {
    const format = url.searchParams.get("format") ?? "json";
    const data = repository.exportData();
    const bundle = createExportBundle({ exportedAt: nowInstant(), ...data });
    if (format === "json") {
      const payload = serializeExportJson(bundle);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": contentDisposition("lifeos-export.json"),
        "cache-control": "no-store",
      });
      res.end(payload);
      return true;
    }
    if (format === "markdown") {
      const payload = data.records.map((record) => exportRecordMarkdown(record, data)).join("\n\n---\n\n");
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": contentDisposition("lifeos-export.md"),
        "cache-control": "no-store",
      });
      res.end(payload);
      return true;
    }
    throw new HttpError(400, "invalid_format", "format must be json or markdown");
  }
  if (pathname === "/api/import" && req.method === "POST") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["bundle"]);
    if (input.bundle === undefined) throw new HttpError(400, "invalid_bundle", "bundle is required");
    let bundle;
    try {
      bundle = parseExportJson(JSON.stringify(input.bundle));
    } catch (error) {
      throw new HttpError(400, "invalid_bundle", error instanceof Error ? error.message : "Invalid export bundle");
    }
    // A bundle is the one payload that can carry a reference to nothing; check
    // the whole graph before it reaches the transaction.
    assertImportReferences(bundle, repository);
    try {
      repository.importData(bundle);
    } catch (error) {
      if (error instanceof ConflictError) throw new HttpError(409, "import_conflict", error.message);
      throw error;
    }
    setJson(res, 201, { imported: bundle.records.length, entities: bundle.entities.length, assets: bundle.assets.length });
    return true;
  }

  return false;
};
