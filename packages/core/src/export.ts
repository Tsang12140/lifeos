import {
  assertValidAsset,
  assertValidCycleIntimacyModuleData,
  assertValidEntity,
  assertValidInstantTime,
  assertValidTimelineRecord,
  type Asset,
  type AssetLink,
  type CycleIntimacyModuleData,
  type Entity,
  type InstantTime,
  type TimelineRecord,
} from "./model.js";

export const EXPORT_FORMAT = "lifeos.export" as const;
export const EXPORT_VERSION = 1 as const;

export interface ExportBundleV1 {
  readonly format: typeof EXPORT_FORMAT;
  readonly version: typeof EXPORT_VERSION;
  readonly exportedAt: InstantTime;
  readonly records: readonly TimelineRecord[];
  readonly entities: readonly Entity[];
  readonly assets: readonly Asset[];
  /** Optional so existing v1 exports stay importable. */
  readonly modules?: {
    readonly cycleIntimacy?: CycleIntimacyModuleData;
  };
}

export interface ExportBundleInput {
  readonly exportedAt: InstantTime;
  readonly records: readonly TimelineRecord[];
  readonly entities?: readonly Entity[];
  readonly assets?: readonly Asset[];
  readonly modules?: ExportBundleV1["modules"];
}

export function createExportBundle(input: ExportBundleInput): ExportBundleV1 {
  const bundle: ExportBundleV1 = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: input.exportedAt,
    records: input.records,
    entities: input.entities ?? [],
    assets: input.assets ?? [],
    ...(input.modules === undefined ? {} : { modules: input.modules }),
  };
  assertValidExportBundle(bundle);
  return bundle;
}

export function serializeExportJson(bundle: ExportBundleV1, indent = 2): string {
  assertValidExportBundle(bundle);
  return `${JSON.stringify(bundle, null, indent)}\n`;
}

export function parseExportJson(json: string): ExportBundleV1 {
  const parsed: unknown = JSON.parse(json);
  assertValidExportBundle(parsed);
  return parsed;
}

export function assertValidExportBundle(value: unknown): asserts value is ExportBundleV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Export bundle must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.format !== EXPORT_FORMAT || candidate.version !== EXPORT_VERSION) {
    throw new Error("Unsupported LifeOS export format or version");
  }
  if (!Array.isArray(candidate.records) || !Array.isArray(candidate.entities) || !Array.isArray(candidate.assets)) {
    throw new Error("Export bundle collections must be arrays");
  }
  assertValidInstantTime(candidate.exportedAt, "exportedAt");
  for (const record of candidate.records) {
    assertValidTimelineRecord(record);
  }
  for (const entity of candidate.entities) {
    assertValidEntity(entity);
  }
  for (const asset of candidate.assets) {
    assertValidAsset(asset);
  }
  if (candidate.modules !== undefined) {
    if (typeof candidate.modules !== "object" || candidate.modules === null || Array.isArray(candidate.modules)) {
      throw new Error("export.modules must be an object");
    }
    const modules = candidate.modules as Record<string, unknown>;
    if (modules.cycleIntimacy !== undefined) assertValidCycleIntimacyModuleData(modules.cycleIntimacy, "export.modules.cycleIntimacy");
  }
}

export function quoteYamlScalar(value: string): string {
  // JSON double-quoted strings are valid YAML scalars and cover quotes,
  // backslashes, newlines, colons and leading # without special cases.
  return JSON.stringify(value);
}

export function escapeMarkdownPath(path: string): string {
  // Angle-bracket destinations permit spaces and parentheses. Escape the two
  // characters that still have structural meaning inside that form. Newlines
  // are percent-encoded so a source key cannot break the Markdown link.
  return path
    .replaceAll("\\", "\\\\")
    .replaceAll("<", "\\<")
    .replaceAll(">", "\\>")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function yamlValue(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    return "null";
  }
  return json;
}

function markdownLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}

function assetStorageMetadata(assetRefs: readonly AssetLink[], assets: readonly Asset[]): readonly unknown[] {
  return assetRefs.map((assetRef) => {
    const asset = assets.find((candidate) => candidate.id === assetRef.assetId);
    return {
      assetId: assetRef.assetId,
      role: assetRef.role,
      storageRefs: asset?.storageRefs ?? [],
    };
  });
}

function assetLinkLines(record: TimelineRecord, assets: readonly Asset[]): string[] {
  return record.assetRefs.map((assetRef) => {
    const asset = assets.find((candidate) => candidate.id === assetRef.assetId);
    const linkReference = asset?.storageRefs.find((storageRef) => storageRef.link !== undefined);
    const sourceMetadata = JSON.stringify(
      asset?.storageRefs.map((storageRef) => ({
        sourceId: storageRef.sourceId,
        sourceRef: storageRef.sourceRef,
      })) ?? [],
    );
    if (linkReference?.link !== undefined) {
      const destination =
        linkReference.link.kind === "export-path"
          ? `./${linkReference.link.value.replace(/^\.\//, "")}`
          : linkReference.link.value;
      return `- [${markdownLabel(assetRef.assetId)}](<${escapeMarkdownPath(destination)}>) (${assetRef.role}) — refs: ${sourceMetadata}`;
    }
    return `- assetId ${quoteYamlScalar(assetRef.assetId)} (${assetRef.role}) — refs: ${sourceMetadata}`;
  });
}

export interface MarkdownExportOptions {
  readonly entities?: readonly Entity[];
  readonly assets?: readonly Asset[];
}

export function exportRecordMarkdown(record: TimelineRecord, options: MarkdownExportOptions = {}): string {
  assertValidTimelineRecord(record);
  const entities = options.entities ?? [];
  const assets = options.assets ?? [];
  for (const entity of entities) {
    assertValidEntity(entity);
  }
  for (const asset of assets) {
    assertValidAsset(asset);
  }
  const transcriptRaw = record.body.transcriptRaw ?? [];
  const frontmatter = [
    "---",
    `lifeosFormat: ${quoteYamlScalar(EXPORT_FORMAT)}`,
    `lifeosVersion: ${EXPORT_VERSION}`,
    `recordId: ${quoteYamlScalar(record.id)}`,
    `kind: ${quoteYamlScalar(record.kind)}`,
    `createdAt: ${yamlValue(record.createdAt)}`,
    `updatedAt: ${yamlValue(record.updatedAt ?? null)}`,
    `occurredAt: ${yamlValue(record.occurredAt ?? null)}`,
    `isPrivate: ${yamlValue(record.isPrivate ?? false)}`,
    `isDemo: ${yamlValue(record.isDemo ?? false)}`,
    `isBackfill: ${yamlValue(record.isBackfill ?? false)}`,
    `weather: ${yamlValue(record.weather ?? null)}`,
    `task: ${yamlValue(record.kind === "task" ? record.task : null)}`,
    `entityRefs: ${yamlValue(record.entityRefs)}`,
    `relatedRecordIds: ${yamlValue(record.relatedRecordIds)}`,
    `assetRefs: ${yamlValue(record.assetRefs)}`,
    `assetStorageRefs: ${yamlValue(assetStorageMetadata(record.assetRefs, assets))}`,
    `aiDerived: ${yamlValue(record.aiDerived)}`,
    `knownEntities: ${yamlValue(
      record.entityRefs.map((ref) => ({
        ...ref,
        name: entities.find((entity) => entity.id === ref.entityId)?.name ?? null,
      })),
    )}`,
    "---",
  ];

  const transcripts = transcriptRaw.length
    ? [
        "## Raw transcripts",
        "",
        ...transcriptRaw.flatMap((transcript) => [
          `### ${markdownLabel(transcript.assetId)}`,
          "",
          `- provider: ${quoteYamlScalar(transcript.provider)}`,
          `- model: ${quoteYamlScalar(transcript.model ?? "")}`,
          `- generatedAt: ${yamlValue(transcript.generatedAt)}`,
          "",
          transcript.text,
          "",
        ]),
      ]
    : [];
  const assetsSection = record.assetRefs.length
    ? ["## Assets", "", ...assetLinkLines(record, assets), ""]
    : [];

  return [
    ...frontmatter,
    "",
    "## Original",
    "",
    record.body.original,
    "",
    "## Edited",
    "",
    record.body.edited ?? "",
    "",
    ...transcripts,
    ...assetsSection,
  ].join("\n");
}
