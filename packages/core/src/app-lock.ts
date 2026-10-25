export const APP_LOCK_IDLE_MS = 10 * 60 * 1000;
export const APP_LOCK_TARGETS = [
  { id: 'calendar', label: '日历' }, { id: 'tasks', label: '任务' },
  { id: 'notes', label: '笔记' }, { id: 'dreams', label: '梦境' },
  { id: 'entities', label: '联系人与地点' }, { id: 'assistant', label: 'AI管家' },
  { id: 'cycle', label: '周期与亲密' },
  { id: 'privacy-display', label: '显示私密' }, { id: 'privacy-ai', label: 'AI检索私密' },
] as const;
export type AppLockTarget = typeof APP_LOCK_TARGETS[number]['id'];
export interface AppLockStatus { configured: boolean; targets: readonly AppLockTarget[]; idleMs: number; unlocked: boolean; legacyPassword?: true; }
export const appLockPasswordValid = (value: string) => value.length === 4 && /^[0-9]{4}$/.test(value);
export const appLockRecordTarget = (record: { kind: string; body: { nature?: string } }): AppLockTarget | undefined => record.kind === 'note' ? 'notes' : record.kind === 'task' ? 'tasks' : record.body.nature === 'dream' ? 'dreams' : undefined;
