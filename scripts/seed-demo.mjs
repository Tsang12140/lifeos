// Seed a small, fictional LifeOS workspace through the public API.
//
//   node scripts/seed-demo.mjs [baseUrl] [--clean]
//
// The data in this file is deliberately synthetic and contains no real
// personal names, addresses, private material, or media references. It is
// safe to run after cloning the public repository: no ignored directory is
// required. One record intentionally carries the private flag so the privacy
// UI can be exercised without including a real person's content.
// Records carry an internal marker so the app can hide or delete the whole
// batch without putting visible metadata into a person's words.

const args = process.argv.slice(2);
const cleanRequested = args.includes("--clean");
const positional = args.filter((arg) => !arg.startsWith("--"));
const BASE = (positional[0] ?? process.env.LIFEOS_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const SELF = "self";

async function call(path, init) {
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const post = (path, value) => call(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

const patch = (path, value) => call(path, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

function isoAt(daysAgo, time) {
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

const instant = (daysAgo, time) => ({ kind: "instant", value: isoAt(daysAgo, time) });

// ---------------------------------------------------------------- fictional entities

const entities = [
  { id: SELF, type: "person", name: "我", description: "仅用于演示关系的占位对象" },
  { id: "demo-person-a", type: "person", name: "伙伴甲", aliases: ["甲"], description: "虚构演示人物" },
  { id: "demo-person-b", type: "person", name: "同事乙", aliases: ["乙"], description: "虚构演示人物" },
  { id: "demo-person-c", type: "person", name: "朋友丙", description: "虚构演示人物" },
  { id: "demo-person-d", type: "person", name: "家人丁", description: "虚构演示人物" },

  { id: "demo-place-home", type: "place", name: "住处（示例）", role: "home" },
  { id: "demo-place-office", type: "place", name: "办公区（示例）", role: "work" },
  { id: "demo-place-cafe", type: "place", name: "社区咖啡馆（示例）" },
  { id: "demo-place-park", type: "place", name: "河畔公园（示例）" },
  { id: "demo-place-library", type: "place", name: "公共图书馆（示例）" },

  { id: "demo-project-lifeos", type: "project", name: "LifeOS（示例）", description: "虚构演示项目" },
  { id: "demo-project-weekly", type: "project", name: "每周计划（示例）", description: "虚构演示项目" },
  { id: "demo-topic-reading", type: "topic", name: "阅读（示例）" },
  { id: "demo-topic-health", type: "topic", name: "运动（示例）" },
];

const entityById = new Map(entities.map((entity) => [entity.id, entity]));

// The graph is intentionally small but exercises the relationship cards.
const relationships = [
  { from: SELF, to: "demo-person-a", kind: "partner" },
  { from: SELF, to: "demo-person-b", kind: "colleague" },
  { from: SELF, to: "demo-person-c", kind: "friend" },
  { from: SELF, to: "demo-person-d", kind: "family" },
  { from: "demo-person-b", to: "demo-person-c", kind: "friend" },
];

function refsFor(ids = []) {
  return ids.map((id) => {
    const entity = entityById.get(id);
    if (entity === undefined) throw new Error(`Unknown demo entity: ${id}`);
    return { entityType: entity.type, entityId: entity.id, label: entity.name };
  });
}

// The API resolves @person and #place mentions on write. Explicit refs below
// show that projects/topics can also be attached without inventing a marker.
const plan = [
  { d: 0, t: "07:45", kind: "journal", text: "和@伙伴甲在#住处（示例）商量今天的安排。" },
  { d: 0, t: "09:15", kind: "journal", text: "到#办公区（示例）后，先整理本周的记录结构。", refs: ["demo-project-lifeos"] },
  { d: 0, t: "12:30", kind: "task", text: "和@同事乙确认导出字段", due: "18:00", status: "in_progress", refs: ["demo-project-lifeos"] },
  { d: 0, t: "20:10", kind: "note", text: "把今天的想法记下来，明天继续完善。", refs: ["demo-topic-reading"] },

  { d: 1, t: "08:30", kind: "journal", text: "在#社区咖啡馆（示例）写下三条本周优先级。", refs: ["demo-project-weekly"] },
  { d: 1, t: "18:20", kind: "journal", text: "@朋友丙分享了一个很实用的整理方法。" },
  { d: 1, t: "21:00", kind: "task", text: "完成每周计划的回顾", due: "22:30", status: "done", refs: ["demo-project-weekly"] },

  { d: 2, t: "07:20", kind: "journal", text: "沿#河畔公园（示例）走了一圈，精神好多了。", refs: ["demo-topic-health"] },
  { d: 2, t: "19:30", kind: "event", text: "和@伙伴甲在#社区咖啡馆（示例）碰面，聊到下个月的安排。" },
  { d: 2, t: "22:00", kind: "note", text: "阅读十页，先保持每天一点点的节奏。", refs: ["demo-topic-reading"] },

  { d: 3, t: "10:00", kind: "journal", text: "@家人丁提醒我周末记得休息。" },
  { d: 3, t: "15:40", kind: "journal", text: "下午在#公共图书馆（示例）安静工作。" },
  { d: 3, t: "20:30", kind: "task", text: "整理下周的三件重要事项", due: "23:00", status: "todo", refs: ["demo-project-weekly"] },

  { d: 4, t: "09:10", kind: "journal", text: "在#住处（示例）完成一轮简单收纳。" },
  { d: 4, t: "16:00", kind: "journal", text: "@同事乙发来反馈，准备明天集中处理。" },
  { d: 4, t: "21:20", kind: "note", text: "这条是虚构的隐私演示记录。", private: true },

  { d: 5, t: "11:00", kind: "journal", text: "和@朋友丙在#河畔公园（示例）散步，顺便复盘这一周。" },
  { d: 5, t: "19:00", kind: "task", text: "归档本周笔记", due: "21:00", status: "cancelled", refs: ["demo-project-lifeos"] },
  { d: 6, t: "14:30", kind: "event", text: "在#公共图书馆（示例）参加一场虚构的读书分享会。", backfill: true, refs: ["demo-topic-reading"] },
  { d: 8, t: "08:00", kind: "journal", text: "新的一周从#办公区（示例）开始，先做一件最重要的事。" },
  { d: 10, t: "20:40", kind: "note", text: "把生活拆成可回看的片段，记录就会慢慢变得有用。", refs: ["demo-project-lifeos"] },
];

// Link a few entries to demonstrate cross-record context in the editor.
const links = [
  [2, 0],
  [6, 4],
  [12, 9],
  [17, 14],
];

async function main() {
  const health = await call("/api/health");
  if (health.status !== 200) {
    console.error(`API is not reachable at ${BASE} (GET /api/health -> ${health.status}). Start it first, then re-run.`);
    process.exit(1);
  }

  const first = await post("/api/entities", entities[0]);
  if (first.status === 409) {
    console.error("Demo entities already exist. Remove them in the app or run: node scripts/seed-demo.mjs --clean");
    process.exit(1);
  }
  if (first.status !== 201) {
    console.error(`Could not create demo entities: ${first.status} ${JSON.stringify(first.body)}`);
    process.exit(1);
  }

  let failures = 0;
  const problems = [];
  for (const entity of entities.slice(1)) {
    const result = await post("/api/entities", entity);
    if (result.status !== 201) {
      failures += 1;
      problems.push(`entity ${entity.id}: ${result.status} ${JSON.stringify(result.body)}`);
    }
  }
  for (const relationship of relationships) {
    const result = await post(`/api/entities/${encodeURIComponent(relationship.from)}/relations`, {
      kind: relationship.kind,
      targetId: relationship.to,
    });
    if (result.status !== 200) {
      failures += 1;
      problems.push(`relation ${relationship.from}->${relationship.to}: ${result.status} ${JSON.stringify(result.body)}`);
    }
  }

  const created = [];
  for (const entry of plan) {
    const payload = {
      kind: entry.kind,
      content: entry.text,
      isDemo: true,
      ...(entry.private ? { isPrivate: true } : {}),
      ...(entry.backfill ? { isBackfill: true } : {}),
      entityRefs: refsFor(entry.refs),
      relatedRecordIds: [],
      assetRefs: [],
      occurredAt: instant(entry.d, entry.t),
    };
    if (entry.due !== undefined) payload.dueAt = instant(entry.d, entry.due);
    const result = await post("/api/records", payload);
    if (result.status !== 201) {
      failures += 1;
      problems.push(`record "${entry.text.slice(0, 18)}…": ${result.status} ${JSON.stringify(result.body)}`);
      created.push(null);
      continue;
    }
    created.push(result.body);
    if (entry.status !== undefined) {
      const updated = await patch(`/api/records/${encodeURIComponent(result.body.id)}`, {
        revision: result.body.revision,
        status: entry.status,
      });
      if (updated.status === 200) {
        // Keep the newest revision for the cross-record links below.
        created[created.length - 1] = updated.body;
      } else {
        failures += 1;
        problems.push(`status ${result.body.id}: ${updated.status} ${JSON.stringify(updated.body)}`);
      }
    }
  }

  for (const [from, to] of links) {
    const source = created[from];
    const target = created[to];
    if (source === null || source === undefined || target === null || target === undefined) continue;
    const result = await patch(`/api/records/${encodeURIComponent(source.id)}`, {
      revision: source.revision,
      relatedRecordIds: [target.id],
    });
    if (result.status !== 200) {
      failures += 1;
      problems.push(`link ${from}->${to}: ${result.status} ${JSON.stringify(result.body)}`);
    }
  }

  const mentionLinks = created.reduce((total, record) => total + (record?.entityRefs?.length ?? 0), 0);
  const days = new Set(plan.map((entry) => entry.d)).size;
  console.log(`Seeded ${created.filter(Boolean).length} fictional demo records across ${days} days.`);
  console.log(`${entities.length} fictional people/places/projects/topics, ${relationships.length} relations, ${mentionLinks} entity links.`);
  console.log("No photos, audio, files, or external paths were created.");
  if (failures > 0) {
    console.log(`${failures} step(s) failed:`);
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("All steps succeeded.");
  }
}

async function clean() {
  const payload = await call(`/api/records?timeZone=${encodeURIComponent("Asia/Shanghai")}`);
  const items = (Array.isArray(payload.body?.items) ? payload.body.items : []).filter((item) => item?.isDemo === true);
  for (const record of items) {
    await call(`/api/records/${encodeURIComponent(record.id)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: record.revision }),
    });
  }
  const objects = await call("/api/entities");
  // `self` is a reserved application identity and may belong to the user
  // before a demo run. Remove only explicitly demo-prefixed entities.
  const demoEntities = (objects.body?.items ?? []).filter((item) => String(item.id).startsWith("demo-"));
  for (const entity of demoEntities) await call(`/api/entities/${encodeURIComponent(entity.id)}`, { method: "DELETE" });
  const stored = await call("/api/assets");
  const demoAssets = (stored.body?.items ?? []).filter((item) => String(item.id).startsWith("demo-"));
  for (const asset of demoAssets) await call(`/api/assets/${encodeURIComponent(asset.id)}`, { method: "DELETE" });
  console.log(`Removed ${items.length} demo records, ${demoEntities.length} objects, ${demoAssets.length} asset references.`);
}

if (cleanRequested) await clean();
else await main();
