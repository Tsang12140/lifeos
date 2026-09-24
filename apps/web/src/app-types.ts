import type { Entity, EntityKind, PlacePeriod, PlaceRole, RecordKind } from "@lifeos/core";

export type AppView = "today" | "timeline" | "calendar" | "tasks" | "notes" | "entities" | "timemachine" | "settings";
export type SettingsPageId = "account/session" | "data/import-export" | "data/backup" | "data/demo" | "data/photos" | "appearance/interface" | "integrations/weather" | "integrations/ai" | "integrations/movie" | "private/cycle" | "about";
export type CalendarMode = "week" | "month";
export type ComposerKind = Extract<RecordKind, "journal" | "task" | "event" | "note">;
export type UiFontId = "misans";

/** Everything the create form can collect in one shot. */
export interface EntityCreateRequest {
  readonly type: "person" | "place";
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly role?: PlaceRole;
  readonly period?: PlacePeriod;
  readonly address?: string;
}

export type CreateEntity = (
  type: EntityKind,
  name: string,
  extras?: {
    readonly aliases?: readonly string[];
    readonly role?: PlaceRole;
    readonly period?: PlacePeriod;
    readonly address?: string;
  },
) => Promise<Entity | null>;
