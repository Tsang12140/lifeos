import type { Entity, EntityKind, PlaceDetails, PlacePeriod, PlaceRole, RecordKind } from "@lifeos/core";

export type AppView = "today" | "gallery" | "dreams" | "timeline" | "calendar" | "tasks" | "notes" | "entities" | "timemachine" | "settings";
export type SettingsPageId = "account/lock" | "account/session" | "account/storage" | "admin/attention" | "admin/welcome" | "admin/welcome-stats" | "data/import-export" | "data/backup" | "data/demo" | "data/photos" | "appearance/interface" | "integrations/weather" | "integrations/ai" | "integrations/ai-log" | "integrations/movie" | "integrations/photo-text" | "private/cycle" | "about";
export type CalendarMode = "week" | "month";
export type ComposerKind = Extract<RecordKind, "journal" | "task" | "event" | "note">;
export type UiFontId = "auto";

/** Everything the create form can collect in one shot. */
export interface EntityCreateRequest extends PlaceDetails {
  readonly existing?: Entity;
  readonly wechat?: string;
  readonly residence?: string;
  readonly type: "person" | "place";
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly role?: PlaceRole;
  readonly period?: PlacePeriod;
  readonly address?: string;
}

export interface EntityEditPatch {
  readonly wechat?: string | null;
  readonly residence?: string | null;
  readonly phone?: string | null;
  readonly city?: string | null;
  readonly province?: string | null;
  readonly district?: string | null;
  readonly amapId?: string | null;
  readonly photoUrl?: string | null;
  readonly longitude?: number | null;
  readonly latitude?: number | null;
  readonly isImportant?: boolean;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description?: string;
  readonly role?: PlaceRole | null;
  readonly period?: PlacePeriod | null;
  readonly address?: string | null;
}

export type CreateEntity = (
  type: EntityKind,
  name: string,
  extras?: {
    readonly wechat?: string;
    readonly residence?: string;
    readonly aliases?: readonly string[];
    readonly role?: PlaceRole;
    readonly period?: PlacePeriod;
    readonly address?: string;
  } & PlaceDetails,
) => Promise<Entity | null>;
