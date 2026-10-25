import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantDraftPosition } from '../src/assistant-draft-position.ts';

const batch = { id: 'dream', createdAt: '2026-10-19T01:00:00.000Z' };
test('draft stays with its creating reply across later chat, edits and confirmation', () => {
  const messages = [
    { role: 'user' as const, at: '2026-10-19T00:59:00Z' },
    { role: 'assistant' as const, at: '2026-10-19T01:00:00.002Z', draftBatchId: batch.id },
    { role: 'user' as const, at: '2026-10-20T00:00:00Z' },
    { role: 'assistant' as const, at: '2026-10-20T00:01:00Z' },
  ];
  assert.equal(assistantDraftPosition(messages, batch), 1);
  assert.equal(assistantDraftPosition(messages, { ...batch, updatedAt: '2026-10-20T02:00:00Z' } as typeof batch), 1);
  assert.equal(assistantDraftPosition(messages.map(({ draftBatchId, ...m }) => m), batch), 1);
});
test('older draft precedes a paginated tail; standalone draft remains accessible', () => {
  assert.equal(assistantDraftPosition([{ role: 'user', at: '2026-10-20T00:00:00Z' }, { role: 'assistant', at: '2026-10-20T00:01:00Z' }], batch), -1);
  assert.equal(assistantDraftPosition([], batch), -1);
  assert.equal(assistantDraftPosition([{ role: 'assistant', at: '2026-10-18T01:00:00Z' }], batch), 0);
});
