/** Durable daily artwork, shared by month and week. URLs name an immutable asset version. */
export interface CalendarPhoto {
  readonly assetId: string;
  readonly version: string;
}
export interface CalendarCover {
  readonly position: string;
  readonly score: number;
  readonly textPenalty: number;
}
export interface CalendarPresentation {
  readonly date: string;
  readonly phase: "provisional" | "final";
  readonly sourceHash: string;
  readonly firstRecordId?: string;
  readonly monthPhoto?: CalendarPhoto;
  readonly monthCovers: Readonly<Record<string, CalendarCover>>;
  readonly weekPhotos: readonly CalendarPhoto[];
  readonly updatedAt: string;
  readonly retryAfter?: number;
}

export function calendarPhotoUrl(photo: CalendarPhoto): string {
  return `/api/assets/${encodeURIComponent(photo.assetId)}/thumbnail?w=400&v=${encodeURIComponent(photo.version)}`;
}

export function calendarCoverForAspect(day: CalendarPresentation | undefined, aspect: number): CalendarCover | undefined {
  if (day === undefined) return undefined;
  const key = Object.keys(day.monthCovers).sort((a, b) => Math.abs(Math.log(Number(a) / aspect)) - Math.abs(Math.log(Number(b) / aspect)))[0];
  return key === undefined ? undefined : day.monthCovers[key];
}
