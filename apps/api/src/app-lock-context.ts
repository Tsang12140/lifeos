import { AsyncLocalStorage } from 'node:async_hooks';
import { appLockRecordTarget, type AppLockTarget } from '@lifeos/core';
import { HttpError } from './http-kit.js';
import type { SqliteRecordRepository } from './repository.js';
export interface AppLockRequest {
  locked: (target: AppLockTarget) => boolean;
  ai: boolean;
  protected?: boolean;
  /** The in-memory token unlocked this page. */
  unlocked?: boolean;
  /** Media GETs also accept the unlock cookie, so a cached thumbnail may be reused after reload. */
  mediaUnlocked?: boolean;
}
export const appLockRequests = new AsyncLocalStorage<AppLockRequest>();
const originals = new WeakMap<SqliteRecordRepository, SqliteRecordRepository>();
const policies = new WeakMap<SqliteRecordRepository, AppLockRequest>();
export const appLockRepositoryIdentity = (repository: SqliteRecordRepository) => originals.get(repository) ?? repository;
export const appLockRepositoryPolicy = (repository: SqliteRecordRepository) => policies.get(repository);
export const appTargetLocked = (target: AppLockTarget) => appLockRequests.getStore()?.locked(target) ?? false;
export function requireAppTarget(target: AppLockTarget) {
  if (appTargetLocked(target)) throw new HttpError(423, 'app_locked', '请先解锁后继续', { targets: [target] });
}
export function appRecordReadable(record: { kind: string; isPrivate?: boolean; body: { nature?: string } }): boolean {
  const target = appLockRecordTarget(record);
  return !(target && appTargetLocked(target)) && !(record.isPrivate && appTargetLocked(appLockRequests.getStore()?.ai ? 'privacy-ai' : 'privacy-display'));
}
export function requireAppRecord(record: Parameters<typeof appRecordReadable>[0]) {
  const target = appLockRecordTarget(record); if (target) requireAppTarget(target);
  if (record.isPrivate) requireAppTarget(appLockRequests.getStore()?.ai ? 'privacy-ai' : 'privacy-display');
}
/** Each method scopes its internal calls too; background services keep the original repository. */
export function appLockRepository(repository: SqliteRecordRepository, policy: AppLockRequest): SqliteRecordRepository {
  if (!policy.protected) return repository;
  const proxy = new Proxy(repository, { get(target, key) {
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? (...args: unknown[]) => appLockRequests.run(policy, () => {
      if (/^(assistant|createAssistant|setAssistant|touchAssistant|appendAssistant|beginAssistant|retryAssistant|retainAssistant|completeAssistant|resumeAssistant|clearAssistant|deleteAssistant|saveAssistant)/.test(String(key))) requireAppTarget('assistant');
      if (/^(writeCycle|replaceCycle|addCycle|deleteCycle|editCycle|undoCycle|createHabit|updateHabit|deleteHabit|markHabit)/.test(String(key))) requireAppTarget('cycle');
      return value.apply(target, args);
    }) : value;
  } });
  originals.set(proxy, repository); policies.set(proxy, policy); return proxy;
}
