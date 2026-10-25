import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantMessageTime, assistantTimeDivider } from '../src/assistant-message-time.ts';
import { initialShareSelection, mergeShareMessages, needsEarlierShareWindow, shareMessageDisplayText, shareMessageParts, wrapShareText, type ShareMessage } from '../src/assistant-share-model.ts';

test('assistant timestamps omit current year and retain Chinese dates and padded 24-hour time', () => {
 const now=new Date('2026-10-16T00:00:00Z');
 assert.equal(assistantMessageTime('2026-10-15T17:28:00Z',now),'10月16日 01:28');
 assert.equal(assistantMessageTime('2025-10-15T17:28:00Z',now),'2025年10月16日 01:28');
 assert.equal(assistantMessageTime('2026-01-01T16:00:00Z',now),'1月2日 00:00');
 assert.equal(assistantMessageTime('2025-12-31T16:00:00Z',new Date('2025-12-31T16:01:00Z')),'1月1日 00:00');
 assert.equal(assistantMessageTime('invalid',now),'');assert.equal(assistantMessageTime(undefined,now),'');
});

test('share window is fixed to the clicked time, inclusive at thirty minutes and never expands by adjacent gaps',()=>{
 const m=[
  {id:'old-q',role:'user' as const,text:'旧',at:'2026-10-16T00:00:00Z',seq:1},
  {id:'old-a',role:'assistant' as const,text:'旧答',at:'2026-10-16T00:10:00Z',seq:2},
  {id:'edge-q',role:'user' as const,text:'边界',at:'2026-10-16T00:30:00Z',seq:3},
  {id:'edge-a',role:'assistant' as const,text:'边界答',at:'2026-10-16T00:40:00Z',seq:4},
  {id:'q',role:'user' as const,text:'问',at:'2026-10-16T00:59:00Z',seq:5},
  {id:'a',role:'assistant' as const,text:'答',at:'2026-10-16T01:00:00Z',seq:6},
  {id:'future',role:'user' as const,text:'后来的',at:'2026-10-16T01:01:00Z',seq:7}
 ];
 assert.deepEqual([...initialShareSelection(m,5)],['edge-q','edge-a','q','a']);
 assert.equal(needsEarlierShareWindow(m,'a'),false);
 assert.equal(needsEarlierShareWindow(m.slice(2),'a'),true);
 const merged=mergeShareMessages(m.slice(0,4),m.slice(2));
 assert.deepEqual(merged,m);
});

test('window answers retain an earlier question and missing times never become guessed dates',()=>{
 const m=[{id:'q',role:'user' as const,text:'慢问题',at:'2026-10-16T00:00:00Z'}, {id:'a',role:'assistant' as const,text:'慢回答',at:'2026-10-16T01:00:00Z'}];
 assert.deepEqual(new Set(initialShareSelection(m,1)),new Set(['q','a']));
 assert.equal(needsEarlierShareWindow(m.slice(1),'a'),true);
 assert.equal(needsEarlierShareWindow(m,'a'),false);
 assert.deepEqual([...initialShareSelection([{...m[0],at:'bad'},{...m[1],at:undefined}],1)],['a','q']);
});
test('chat dividers mark five minutes or Shanghai day transitions, not every turn',()=>{
 assert.equal(assistantTimeDivider('2026-10-15T17:28:00Z','2026-10-15T17:32:59Z'),false);
 assert.equal(assistantTimeDivider('2026-10-15T17:28:00Z','2026-10-15T17:33:00Z'),true);
 assert.equal(assistantTimeDivider('2026-10-15T15:59:59Z','2026-10-15T16:00:01Z'),true);
 assert.equal(assistantTimeDivider(undefined,'2026-10-15T16:00:01Z'),false);
 assert.equal(assistantTimeDivider('bad','bad'),false);
});
test('share defaults to clicked answer and preceding question; isolated messages remain independently selectable',()=>{
 const messages=[{id:'u1',role:'user' as const,text:'第一问'},{id:'a1',role:'assistant' as const,text:'第一答'},{id:'u2',role:'user' as const,text:'第二问'},{id:'a2',role:'assistant' as const,text:'第二答'}];
 assert.deepEqual([...initialShareSelection(messages,3)],['a2','u2']);
 assert.deepEqual([...initialShareSelection(messages,0)],['u1']);
 assert.equal(initialShareSelection(messages,99).size,0);
 assert.deepEqual(wrapShareText('一二😀三\n\nlongword',3,s=>[...s].length),['一二😀','三','','lon','gwo','rd']);
 assert.deepEqual(wrapShareText('👨‍👩‍👧‍👦你',1,s=>[...new Intl.Segmenter('zh-CN',{granularity:'grapheme'}).segment(s)].length),['👨‍👩‍👧‍👦','你']);
});

test('share display keeps emphasis and verified citations while omitting unmatched source markers',()=>{
 const message:ShareMessage={id:'a',role:'assistant',text:'先说**重要判断**。[1] 再看[2]。',ui:{offers:[{label:'来源 1 2026-10-18',command:{type:'record.focus',params:{recordId:'real-source'}}}]}};
 const parts=shareMessageParts(message);
 assert.equal(shareMessageDisplayText(message),'先说重要判断。[1] 再看。');
 assert.equal(shareMessageDisplayText(message).includes('**'),false);
 assert.equal(parts.find(part=>part.strong)?.text,'重要判断');
 assert.deepEqual(parts.filter(part=>part.kind==='citation').map(part=>[part.kind,part.number,part.offer?.label]),[['citation',1,'来源 1 2026-10-18']]);
 assert.equal(parts.map(part=>part.text).join(''),shareMessageDisplayText(message));
 for(const part of parts)assert.equal(shareMessageDisplayText(message).slice(part.start,part.end),part.text);
 const rawUser:ShareMessage={id:'u',role:'user',text:'用户输入 **按原样显示** [1]'};
 assert.equal(shareMessageDisplayText(rawUser),'用户输入 **按原样显示** [1]');
 const code:ShareMessage={id:'code',role:'assistant',text:'代码：\n\n```js\n[1]\n\n[2]\n```\n\n普通事实[3]。'};
 assert.equal(shareMessageDisplayText(code),code.text.replace('[3]',''));
});
