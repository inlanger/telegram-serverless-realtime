import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, room, clientA, context} from './fixture.mjs';
import {createReceiver} from './receiver.mjs';
const envelope = outbox => ({room, clientId: clientA, outbox, after: 0, waitMs: 0});
const packet = (requestId, value = {}) => ({requestId, kind: 'pulse', value});

test('combined send + ACK + read matches separate operations, with unchanged DB work', async t => {
  const a = fixture(), b = fixture(); t.after(() => {a.close(); b.close();});
  for (const f of [a,b]) await f.publish('remote');
  const outbox = [packet('local', {x:1}), {requestId:'ack_remote',kind:'ack',value:{seq:1}}];
  for (const p of outbox) await a.service({op:'publish',room,clientId:clientA,...p},context(1));
  const separate = await a.read();
  const combined = await b.exchange(envelope(outbox),context(1));
  assert.deepEqual(combined.events,separate.events);
  assert.deepEqual(combined.receipts.map(x=>x.seq),[2,3]);
  assert.deepEqual(a.counts,b.counts);
});

test('response loss after a committed batch: same IDs recover receipts without new rows', async t => {
  const f=fixture(); t.after(f.close);
  const input=envelope([packet('one'),packet('two')]);
  const lost=await f.exchange(input,context(1)); // Deliberately discard as if HTTP response was lost.
  const retry=await f.exchange(input,context(1));
  assert.deepEqual(retry.receipts,lost.receipts);assert.equal(retry.events.length,2);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM realtime_events').get().n,2);
});

test('a failed later packet leaves a replayable prefix, not a claimed atomic batch', async t => {
  const f=fixture(); t.after(f.close);
  await assert.rejects(f.exchange(envelope([packet('one'),packet('bad','x'.repeat(1025))]),context(1)),{code:'INVALID_INPUT'});
  assert.equal((await f.read()).events.length,1);
  const retry=await f.exchange(envelope([packet('one'),packet('two')]),context(1));
  // SQLite AUTOINCREMENT can consume a number on a deduplicated INSERT.
  assert.equal(retry.receipts[0].seq,1);assert.ok(retry.receipts[1].seq>1);
  assert.equal(retry.events.length,2);
  await assert.rejects(f.exchange(envelope([packet('one',{changed:true})]),context(1)),{code:'ID_REUSED'});
});

test('identity, membership and packet field boundaries survive batching', async t => {
  const f=fixture();t.after(f.close);
  await assert.rejects(f.exchange(envelope([packet('one')]),{}),{code:'AUTH_REQUIRED'});
  await assert.rejects(f.exchange(envelope([]),context(3)),{code:'ROOM_UNAVAILABLE'});
  const result=await f.exchange(envelope([{...packet('one'),op:'create',room:'f'.repeat(32),clientId:'f'.repeat(32)}]),context(1));
  assert.equal(result.events[0].clientId,clientA);
  await assert.rejects(f.exchange(envelope(Array.from({length:9},()=>packet('many'))),context(1)),{code:'INVALID_INPUT'});
});

test('uploads never wait for an idle read before returning their receipts', async t => {
  let waits=0;const f=fixture(async()=>{waits++;});t.after(f.close);
  await f.exchange({...envelope([packet('one')]),after:100,waitMs:12000},context(1));
  assert.equal(waits,0);
});

test('reversed overlapping responses are applied once and in order', async()=>{
  const seen=[],receiver=createReceiver(async event=>{await Promise.resolve();seen.push(event.seq);});
  await Promise.all([receiver.accept({events:[{seq:1},{seq:2},{seq:3}]}),receiver.accept({events:[{seq:1},{seq:2}]})]);
  assert.deepEqual(seen,[1,2,3]);assert.deepEqual(receiver.stats,{cursor:3,duplicates:2,applied:3});
});

test('cursor does not skip a failed handler; replay can resume', async()=>{
  let fail=true;const seen=[],receiver=createReceiver(async event=>{
    if(event.seq===2&&fail){fail=false;throw new Error('handler failed');}seen.push(event.seq);
  });
  const batch={events:[{seq:1},{seq:2},{seq:3}]};
  await assert.rejects(receiver.accept(batch));assert.equal(receiver.cursor,1);
  await receiver.accept(batch);assert.deepEqual(seen,[1,2,3]);
});

test('overlapping paginated prefixes do not lose events', async t=>{
  const f=fixture();t.after(f.close);for(let i=0;i<70;i++)await f.publish('event_'+i);
  const seen=[],receiver=createReceiver(async event=>{seen.push(event.seq);});
  const [a,b]=await Promise.all([f.read(),f.read()]);await Promise.all([receiver.accept(b),receiver.accept(a)]);
  await receiver.accept(await f.read(receiver.cursor));
  assert.equal(seen.length,70);assert.equal(new Set(seen).size,70);assert.equal(receiver.stats.duplicates,64);
});
