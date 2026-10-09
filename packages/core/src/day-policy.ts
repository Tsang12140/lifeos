export function calendarToday(now = new Date(), timeZone = "Asia/Shanghai"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

export function canEditDaySummary(date: string, today: string, records: readonly { readonly kind: string; readonly isPrivate?: boolean }[]): boolean {
  return date <= today && records.some(record => record.kind === "journal" && record.isPrivate !== true);
}
