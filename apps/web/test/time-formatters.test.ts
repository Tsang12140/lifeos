import {test} from 'node:test';
import assert from 'node:assert/strict';
import {USER_TIME_ZONE, lifeTimeDate, lifeTimeTime, lifeTimeToInput, displayDate, shortDate, dayLabel, weekdayShort, localDateToday, localNowInput} from '../src/time.ts';
test('reused formatters retain local day, midnight, leap-day and label semantics',()=>{
 const dateFormat=new Intl.DateTimeFormat('en-US',{timeZone:USER_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
 const clockFormat=new Intl.DateTimeFormat('en-GB',{timeZone:USER_TIME_ZONE,hour:'2-digit',minute:'2-digit',hourCycle:'h23',hour12:false});
 for(const value of ['2026-10-12T15:59:00Z','2026-10-12T16:00:00Z','2024-02-29T16:00:00Z','2000-01-01T00:00:00Z']){
  const instant={kind:'instant' as const,value,timeZone:USER_TIME_ZONE};
  const day=Object.fromEntries(dateFormat.formatToParts(new Date(value)).map(p=>[p.type,p.value]));
  const clock=Object.fromEntries(clockFormat.formatToParts(new Date(value)).map(p=>[p.type,p.value]));
  assert.equal(lifeTimeDate(instant),day.year+'-'+day.month+'-'+day.day);
  assert.equal(lifeTimeTime(instant),clock.hour+':'+clock.minute);
  assert.equal(lifeTimeToInput(instant),day.year+'-'+day.month+'-'+day.day+'T'+clock.hour+':'+clock.minute);
 }
 assert.equal(lifeTimeDate({kind:'instant',value:'invalid',timeZone:USER_TIME_ZONE}),undefined);
 assert.equal(lifeTimeTime({kind:'instant',value:'invalid',timeZone:USER_TIME_ZONE}),'—');
 assert.equal(lifeTimeDate({kind:'date',value:'2024-02-29'}),'2024-02-29');
 assert.equal(displayDate('bad'),'选择日期');assert.equal(shortDate('bad'),'—');assert.equal(dayLabel('bad'),'选日期');assert.equal(weekdayShort('bad'),'—');
 const d='2026-10-13',dt=new Date(d+'T12:00:00');
 assert.equal(displayDate(d),new Intl.DateTimeFormat('zh-CN',{weekday:'long',month:'long',day:'numeric',timeZone:USER_TIME_ZONE}).format(dt));
 assert.equal(shortDate(d),new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric',timeZone:USER_TIME_ZONE}).format(dt));
});
test('re-rendering a long record list does not allocate new ICU formatters',()=>{
 const Original=Intl.DateTimeFormat;let constructions=0;
 Intl.DateTimeFormat=new Proxy(Original,{construct(target,args){constructions++;return Reflect.construct(target,args)}}) as typeof Intl.DateTimeFormat;
 try{for(let i=0;i<500;i++){const value={kind:'instant' as const,value:'2026-10-12T16:00:00Z',timeZone:USER_TIME_ZONE};lifeTimeDate(value);lifeTimeTime(value);lifeTimeToInput(value);displayDate('2026-10-13');shortDate('2026-10-13');dayLabel('2026-10-13');weekdayShort('2026-10-13');localDateToday();localNowInput()}assert.equal(constructions,0)}
 finally{Intl.DateTimeFormat=Original}
});
