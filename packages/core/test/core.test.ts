import test from "node:test";
import { deepStrictEqual, equal, match, ok, throws } from "node:assert/strict";
import {
  assertValidEntity,
  assertValidTimelineRecord,
  canonicalPersonName,
  createDateOnly,
  createExportBundle,
  createInstant,
  createLocalDateTime,
  entitySearchTerms,
  escapeMarkdownPath,
  exportRecordMarkdown,
  findEntityMentions,
  normalizeEntitySearchTerm,
  parseExportJson,
  ruleSummaryText,
  serializeExportJson,
  summaryFingerprint,
  trimSummaryText,
  type Asset,
  type Entity,
  type TaskRecord,
} from "../src/index.js";

const originalText = "今天试记一段原文：\"引号\"、冒号:、井号 #、反斜杠 \\\\，以及\n第二行。";

const taskRecord: TaskRecord = {
  id: "record/特殊-1",
  kind: "task",
  createdAt: createInstant("2026-09-01T10:00:00+08:00", "Asia/Shanghai"),
  occurredAt: createLocalDateTime("2026-09-01T18:30:00"),
  body: {
    original: originalText,
    edited: "整理后的正文，仍然保留原文。",
    transcriptRaw: [
      {
        assetId: "audio/one",
        text: "第一段原始转写",
        provider: "local-placeholder",
        model: "speech-model-1",
        generatedAt: createInstant("2026-09-01T10:01:00+08:00", "Asia/Shanghai"),
      },
      {
        assetId: "audio/two",
        text: "第二段原始转写",
        provider: "other-placeholder",
        model: "speech-model-2",
        generatedAt: createInstant("2026-09-01T10:02:00+08:00", "Asia/Shanghai"),
      },
    ],
  },
  task: {
    status: "todo",
    dueAt: createDateOnly("2026-09-03", "Asia/Shanghai"),
  },
  entityRefs: [
    {
      entityType: "person",
      entityId: "person/张三",
      label: "张三 / 朋友",
    },
    {
      entityType: "topic",
      entityId: "topic:life#review",
    },
  ],
  relatedRecordIds: ["journal/昨天"],
  assetRefs: [
    { assetId: "audio/one", role: "recording" },
    { assetId: "audio/two", role: "recording" },
    { assetId: "photo/one", role: "photo" },
  ],
  aiDerived: [
    {
      id: "derived/1",
      kind: "classification",
      value: {
        labels: ["工作", "回顾"],
        note: "机器结果，不是原文",
      },
      provider: "deepseek",
      model: "deepseek-reasoner",
      generatedAt: createInstant("2026-09-01T10:03:00+08:00", "Asia/Shanghai"),
      sourceRecordId: "record/特殊-1",
      sourceRevision: "revision-1",
      confidence: 0.82,
    },
  ],
};

const entities: readonly Entity[] = [
  {
    type: "person",
    id: "person/张三",
    name: "张三：朋友 #1",
    createdAt: createInstant("2026-08-01T00:00:00+08:00", "Asia/Shanghai"),
  },
  {
    type: "topic",
    id: "topic:life#review",
    name: "Life / Review",
  },
];

const assets: readonly Asset[] = [
  {
    id: "audio/one",
    kind: "audio",
    mediaType: "audio/mpeg",
    storageRefs: [
      {
        sourceId: "local-recordings",
        sourceRef: "recordings/今天 (1).mp3",
      },
    ],
  },
  {
    id: "audio/two",
    kind: "audio",
    mediaType: "audio/mpeg",
    storageRefs: [
      {
        sourceId: "local-recordings",
        sourceRef: "recordings/今天 (2).mp3",
      },
    ],
  },
  {
    id: "photo/one",
    kind: "photo",
    mediaType: "image/jpeg",
    storageRefs: [
      {
        sourceId: "synology-readonly-index",
        sourceRef: "\\\\nas-box\\照片库\\2026\\旅行 (1).jpg",
        link: { kind: "export-path", value: "assets/photo-one.jpg" },
      },
      {
        sourceId: "synology-readonly-index-backup",
        sourceRef: "photos/2026/旅行 (1).jpg",
      },
    ],
  },
];

test("JSON v1 round-trips records, entities, assets, dates, and derivations", () => {
  const bundle = createExportBundle({
    exportedAt: createInstant("2026-09-11T12:00:00+08:00", "Asia/Shanghai"),
    records: [taskRecord],
    entities,
    assets,
  });

  const parsed = parseExportJson(serializeExportJson(bundle));
  deepStrictEqual(parsed, bundle);
  equal(parsed.records[0]?.body.original, originalText);
  equal(parsed.records[0]?.body.transcriptRaw?.[1]?.assetId, "audio/two");
  equal(parsed.records[0]?.aiDerived[0]?.sourceRevision, "revision-1");
  equal(parsed.assets[2]?.storageRefs.length, 2);
});

test("Markdown export quotes YAML values, preserves original text, relations, and escaped paths", () => {
  const markdown = exportRecordMarkdown(taskRecord, { entities, assets });

  match(markdown, /recordId: "record\/特殊-1"/);
  match(markdown, /entityRefs: /);
  match(markdown, /relatedRecordIds: \["journal\/昨天"\]/);
  match(markdown, /assetStorageRefs: /);

  const weatherMarkdown = exportRecordMarkdown({
    ...taskRecord,
    weather: {
      mode: "realtime",
      locationId: "101280601",
      city: "广州",
      text: "雷阵雨",
      icon: "302",
      temperature: "28",
      capturedAt: createInstant("2026-09-01T19:00:00+08:00"),
    },
  }, { entities, assets });
  match(weatherMarkdown, /weather: .*雷阵雨/);
  match(markdown, /aiDerived: /);
  match(markdown, /<\.\/assets\/photo-one\.jpg>/);
  match(markdown, /sourceRef/);
  ok(!markdown.includes("](<\\\\nas-box"));
  ok(markdown.includes(originalText));
  ok(markdown.includes("整理后的正文，仍然保留原文。"));
  match(markdown, /### audio\/one/);
  match(markdown, /provider: "local-placeholder"/);
  match(markdown, /sourceRevision/);
});

test("export keeps original, edited, transcript, and AI-derived content separate", () => {
  const bundle = createExportBundle({
    exportedAt: createInstant("2026-09-11T12:00:00+08:00", "Asia/Shanghai"),
    records: [taskRecord],
    entities,
    assets,
  });
  const json = serializeExportJson(bundle);
  const markdown = exportRecordMarkdown(taskRecord, { entities, assets });

  match(json, /"original":/);
  match(json, /"edited":/);
  match(json, /"transcriptRaw":/);
  match(json, /"sourceRecordId": "record\/特殊-1"/);
  match(json, /"sourceRevision": "revision-1"/);
  ok(markdown.includes(originalText));
  ok(markdown.includes("整理后的正文，仍然保留原文。"));
  ok(markdown.includes("第一段原始转写"));
  ok(markdown.includes("provider: \"local-placeholder\""));
});

test("date-only, instant, and unresolved local time keep distinct meanings", () => {
  equal(taskRecord.createdAt.kind, "instant");
  equal(taskRecord.occurredAt?.kind, "local");
  equal(taskRecord.kind === "task" ? taskRecord.task.dueAt?.kind : undefined, "date");
  equal(taskRecord.createdAt.originalTimeZone, "Asia/Shanghai");
  equal(taskRecord.occurredAt?.originalTimeZone, undefined);
  throws(() => createInstant("2026-09-01T18:30:00"), /Invalid instant/);
  throws(() => createDateOnly("2026-02-31"), /calendar date is out of range/);
  throws(() => createInstant("2026-09-01T25:30:00+99:99"), /time is out of range|timezone offset is out of range/);
  equal(createLocalDateTime("2026-09-01T18:30:00").kind, "local");

  const invalid = { ...taskRecord, createdAt: createLocalDateTime("2026-09-01T10:00:00") };
  throws(() => assertValidTimelineRecord(invalid as never), /must be an instant/);
});

test("export validation rejects an unsupported format", () => {
  throws(() => parseExportJson(JSON.stringify({ format: "other", version: 1 })), /Unsupported LifeOS export format or version/);
});

test("JSON import rejects malformed records instead of trusting a cast", () => {
  const bundle = createExportBundle({
    exportedAt: createInstant("2026-09-11T12:00:00+08:00", "Asia/Shanghai"),
    records: [taskRecord],
    entities,
    assets,
  });
  const malformed = JSON.parse(serializeExportJson(bundle)) as Record<string, unknown>;
  const records = malformed.records as Record<string, unknown>[];
  delete records[0]?.entityRefs;
  throws(() => parseExportJson(JSON.stringify(malformed)), /record\.entityRefs must be an array/);

  const badKind = JSON.parse(serializeExportJson(bundle)) as Record<string, unknown>;
  const badKindRecords = badKind.records as Record<string, unknown>[];
  badKindRecords[0] = { ...badKindRecords[0], kind: "bogus" };
  throws(() => parseExportJson(JSON.stringify(badKind)), /record\.kind has an unsupported value/);

  const badStatus = JSON.parse(serializeExportJson(bundle)) as Record<string, unknown>;
  const badStatusRecords = badStatus.records as Record<string, unknown>[];
  badStatusRecords[0] = {
    ...badStatusRecords[0],
    task: { ...(badStatusRecords[0]?.task as Record<string, unknown>), status: "wat" },
  };
  throws(() => parseExportJson(JSON.stringify(badStatus)), /record\.task\.status has an unsupported value/);
});

test("asset links reject URI schemes and unsafe paths", () => {
  const baseAsset = assets[2]!;
  const makeAsset = (link: { kind: "url" | "export-path"; value: string }): Asset => ({
    ...baseAsset,
    storageRefs: [{ ...baseAsset.storageRefs[0]!, link }],
  });
  throws(
    () =>
      createExportBundle({
        exportedAt: createInstant("2026-09-11T12:00:00+08:00", "Asia/Shanghai"),
        records: [taskRecord],
        entities,
        assets: [makeAsset({ kind: "url", value: "javascript:alert(1)" })],
      }),
    /must be an http\(s\) URL/,
  );
  throws(
    () =>
      createExportBundle({
        exportedAt: createInstant("2026-09-11T12:00:00+08:00", "Asia/Shanghai"),
        records: [taskRecord],
        entities,
        assets: [makeAsset({ kind: "export-path", value: "javascript:alert(1)" })],
      }),
    /relative export path/,
  );
  throws(
    () =>
      exportRecordMarkdown(taskRecord, {
        entities,
        assets: [makeAsset({ kind: "url", value: "javascript:alert(1)" })],
      }),
    /must be an http\(s\) URL/,
  );
  const invalidConfidence: TaskRecord = {
    ...taskRecord,
    aiDerived: [{ ...taskRecord.aiDerived[0]!, confidence: Number.NaN }],
  };
  throws(
    () =>
      createExportBundle({
        exportedAt: createInstant("2026-09-11T12:00:00+08:00", "Asia/Shanghai"),
        records: [invalidConfidence],
        entities,
        assets,
      }),
    /confidence must be between 0 and 1/,
  );
});

test("Markdown path escaping protects angle-bracket destinations", () => {
  equal(escapeMarkdownPath("C:\\照片\\a<b> (1).jpg\nnext"), "C:\\\\照片\\\\a\\<b\\> (1).jpg%0Anext");
});

const mentionEntities: readonly Entity[] = [
  { type: "person", id: "person_abin", name: "阿彬", aliases: ["彬哥", "Bin"] },
  { type: "place", id: "place_range", name: "箭馆" },
  { type: "person", id: "person_bar", name: "bar" },
];

test("mentions resolve known names and aliases at the exact position", () => {
  deepStrictEqual(entitySearchTerms(mentionEntities[0]!), ["阿彬", "彬哥", "Bin"]);

  const text = "今天和@阿彬去了箭馆，@Bin 也在。";
  const found = findEntityMentions(text, mentionEntities);
  deepStrictEqual(
    found.map((mention) => `${mention.matched}:${mention.entityId}`),
    ["阿彬:person_abin", "Bin:person_abin"],
  );
  for (const mention of found) {
    equal(text.slice(mention.start, mention.end), `@${mention.matched}`);
  }
});

test("English mentions ignore casing and spaces while contact cards keep the canonical CamelCase", () => {
  const english: readonly Entity[] = [{ type: "person", id: "person_alex", name: "AlexChen", aliases: ["A. Chen"] }];
  equal(canonicalPersonName("alex chen"), "AlexChen");
  equal(canonicalPersonName("AlexChen"), "AlexChen");
  equal(normalizeEntitySearchTerm(" Alex Chen "), normalizeEntitySearchTerm("ALEXCHEN"));
  const text = "和@alex chen吃饭，@ALEXCHEN今天也在。";
  const found = findEntityMentions(text, english);
  deepStrictEqual(found.map((mention) => [mention.entityId, mention.matched]), [["person_alex", "alex chen"], ["person_alex", "ALEXCHEN"]]);
  equal(findEntityMentions("@AlexChenWorking", english).length, 0);
});

test("mentions resolve by marker: @ people, # places, and kinds cannot cross markers", () => {
  const text = "今天和@阿彬去了@箭馆。";
  deepStrictEqual(
    findEntityMentions(text, mentionEntities).map((mention) => mention.entityId),
    ["person_abin"],
  );
  // The marker itself decides the kind: widening kinds can never make @
  // resolve a place or # resolve a person.
  deepStrictEqual(
    findEntityMentions(text, mentionEntities, { kinds: ["person", "place"] }).map((mention) => mention.entityId),
    ["person_abin"],
  );
  equal(findEntityMentions(text, mentionEntities, { kinds: [] }).length, 0);
  equal(findEntityMentions("@箭馆 今天没开", mentionEntities).length, 0);
  equal(findEntityMentions("#阿彬 来了", mentionEntities).length, 0);
});

test("place mentions resolve after # with aliases at the exact position", () => {
  const withHome: readonly Entity[] = [
    { type: "place", id: "place_home", name: "家", aliases: ["爸妈家"] },
    { type: "person", id: "person_abin", name: "阿彬" },
  ];
  const text = "回#爸妈家吃饭，饭后在#家 休息。";
  const found = findEntityMentions(text, withHome);
  deepStrictEqual(
    found.map((mention) => `${mention.matched}:${mention.entityId}`),
    ["爸妈家:place_home", "家:place_home"],
  );
  for (const mention of found) {
    equal(text.slice(mention.start, mention.end), `#${mention.matched}`);
  }
  equal(findEntityMentions("@家 见", withHome).length, 0);
});

test("place mentions stay safe around hex colours and doubled markers", () => {
  const places: readonly Entity[] = [
    { type: "place", id: "place_fff", name: "fff" },
    { type: "place", id: "place_home", name: "家" },
  ];
  // A latin word glued to the marker is never a mention…
  equal(findEntityMentions("主题色是x#fff，很好看", places).length, 0);
  // …and an unknown token never matches, hex or otherwise.
  equal(findEntityMentions("主题色是 #001122 看看", places).length, 0);
  equal(findEntityMentions("#ffffff 好看", places).length, 0);
  // "##家" is the picker's force-new trigger, never a mention: the second
  // marker blocks the first, so a doubled trigger saved by accident links
  // nothing.
  equal(findEntityMentions("##家 直接新建", places).length, 0);
  // Repeating a mention is two mentions — the ref layer deduplicates.
  equal(findEntityMentions("#家#家", places).length, 2);
});

test("places carry role and period; other kinds reject them", () => {
  const place = { type: "place", id: "place_home", name: "家", role: "home", period: { from: "2024-03" } };
  assertValidEntity(place);
  assertValidEntity({ ...place, period: { from: "2024-01", until: "2025-08" } });
  assertValidEntity({ ...place, period: { from: "2024-01", until: "2025-08" }, role: "work" });
  throws(() => assertValidEntity({ ...place, period: { from: "2024-13" } }), /YYYY-MM/);
  throws(() => assertValidEntity({ ...place, period: { until: "2026-13" } }), /YYYY-MM/);
  throws(() => assertValidEntity({ ...place, period: { from: "2026-01", until: "2024-01" } }), /must not be after/);
  throws(() => assertValidEntity({ ...place, role: "cafe" }), /unsupported value/);
  throws(() => assertValidEntity({ type: "person", id: "p1", name: "人", role: "home" }), /only allowed on a place/);
  throws(() => assertValidEntity({ type: "person", id: "p1", name: "人", period: { from: "2024-01" } }), /only allowed on a place/);
});

test("entity names and aliases may not start with a mention marker", () => {
  throws(() => assertValidEntity({ type: "person", id: "p1", name: "@带符号的人" }), /must not contain @ or #/);
  throws(() => assertValidEntity({ type: "place", id: "p2", name: "#公司总部" }), /must not contain @ or #/);
  throws(() => assertValidEntity({ type: "person", id: "p1", name: "老王", aliases: ["@老王"] }), /must not contain @ or #/);
  ok(assertValidEntity({ type: "person", id: "p3", name: "张三：朋友 #1" }) === undefined);
});

test("mentions never fire on e-mail addresses, passwords, or unknown names", () => {
  equal(findEntityMentions("mail me at abin@example.com", mentionEntities).length, 0);
  equal(findEntityMentions("密码是 @abin12345 记住", mentionEntities).length, 0);
  equal(findEntityMentions("abin@阿彬", mentionEntities).length, 0);
  equal(findEntityMentions("@阿伟 也来了", mentionEntities).length, 0);
  equal(findEntityMentions("@barbecue 不错", mentionEntities).length, 0);
  equal(findEntityMentions("看到 @阿彬 了", mentionEntities).length, 1);
  equal(findEntityMentions("@bar 到了", mentionEntities).length, 1);
  equal(findEntityMentions("今天和 @阿彬 去了 @箭馆", []).length, 0);
});

test("mentions prefer the longest match and never overlap", () => {
  const both: readonly Entity[] = [
    { type: "person", id: "person_abin", name: "阿彬" },
    { type: "person", id: "person_abin_work", name: "阿彬（同事）" },
  ];
  deepStrictEqual(
    findEntityMentions("今天见@阿彬（同事）和@阿彬", both).map((mention) => mention.entityId),
    ["person_abin_work", "person_abin"],
  );
  deepStrictEqual(
    findEntityMentions("问@彬哥", [{ type: "person", id: "p1", name: "阿彬", aliases: ["彬哥"] }]).map((mention) => mention.entityId),
    ["p1"],
  );
});

test("aliases must be non-empty strings when an entity is validated", () => {
  throws(
    () => createExportBundle({ exportedAt: createInstant("2026-09-11T12:00:00+08:00"), records: [], entities: [{ type: "person", id: "p", name: "阿彬", aliases: [""] }] , assets: [] }),
    /entity\.aliases\[0\] must not be empty/,
  );
});

test("summary text drops markers, tags, and punctuation, then clamps to five characters", () => {
  equal(trimSummaryText("【预置】今天和@阿彬 去了巷口面馆。"), "今天和阿彬");
  equal(trimSummaryText("地铁上站着，把@LifeOS 的想法理了一遍。"), "地铁上站着");
  equal(trimSummaryText("只有两个字"), "只有两个字");
  equal(trimSummaryText(""), "");
  // A caller with a bigger budget gets exactly that many characters, not one fewer.
  equal(trimSummaryText("今天和@阿彬 去了巷口面馆。", 8), "今天和阿彬去了巷");
});

test("the offline summary prefers a theme the day returns to", () => {
  const repeated = [
    { id: "r1", revision: 1, text: "和@小雨 做饭", labels: ["小雨", "做饭"] },
    { id: "r2", revision: 1, text: "小雨说我这样不行", labels: ["小雨"] },
  ];
  equal(ruleSummaryText(repeated), "小雨");

  const oneOff = [
    { id: "r1", revision: 1, text: "去江边走了一段", labels: ["江边"] },
    { id: "r2", revision: 1, text: "读了十页书", labels: ["读书"] },
  ];
  equal(ruleSummaryText(oneOff), "去江边走了");
  equal(ruleSummaryText([]), "");
  // A label seen twice inside one record is still only one record about it.
  equal(ruleSummaryText([{ id: "r1", revision: 1, text: "小雨小雨", labels: ["小雨", "小雨"] }]), "小雨小雨");
});

test("the fingerprint tracks record versions, not insertion order", () => {
  const a = [{ id: "r1", revision: 1 }, { id: "r2", revision: 3 }];
  const reordered = [{ id: "r2", revision: 3 }, { id: "r1", revision: 1 }];
  equal(summaryFingerprint(a), summaryFingerprint(reordered));
  // An edit bumps a revision, which must invalidate the cached summary.
  equal(summaryFingerprint(a) === summaryFingerprint([{ id: "r1", revision: 2 }, { id: "r2", revision: 3 }]), false);
  equal(summaryFingerprint(a) === summaryFingerprint([{ id: "r1", revision: 1 }]), false);
  // Zero records is a real input — a day can be emptied by edits — so the empty
  // key is pinned: the djb2 seed survives a loop that never runs, making it a constant.
  equal(summaryFingerprint([]), "0:45h");
});
