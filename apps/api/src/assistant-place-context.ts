import type { SqliteRecordRepository } from "./repository.js";
import type { BackfillPlan, Entity } from "@lifeos/core";

function safeEntity(entity: Entity): Entity {
  if (entity.type !== "place") return entity;
  const { collectionHistory: _history, ...safe } = entity;
  return safe;
}

/** Stored review snapshots retain provenance; model copies omit its private IDs. */
export function assistantSafePlan(plan: BackfillPlan | undefined): BackfillPlan | undefined {
  return plan ? { ...plan, objects: plan.objects.map(object => object.existingSnapshot ? { ...object, existingSnapshot: safeEntity(object.existingSnapshot) } : object) } : undefined;
}

/** Never send a private source record ID/body through the raw entity payload. */
export function assistantPlaceContext(repository: SqliteRecordRepository) {
  const entities = repository.listEntities();
  return {
    existingObjects: entities.map(safeEntity),
    placeArchives: entities.flatMap(entity => {
      if (entity.type !== "place") return [];
      const archive = repository.placeCollectionArchive(entity.id)!;
      return [{ id: entity.id, name: entity.name, ...archive, ...(archive.firstJournal ? { firstJournal: { ...archive.firstJournal, content: archive.firstJournal.content.slice(0, 1200) } } : {}) }];
    }),
  };
}

export const PLACE_ARCHIVE_RULE = "placeArchives 是地点收录档案：collectedAt 为系统首次收录时间，firstJournal 为首次关联日记，其 occurredAt 是事件日期，两者不能混淆；补写早年的日记不会改变首次收录。时间按 Asia/Shanghai 北京时间展示到秒。unrecorded 表示历史来源未记录，none 表示尚未关联日记，private/unavailable 不得猜测来源或正文。firstJournal.content 最多提供前1200字，不代表日记全文。";
