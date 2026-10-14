import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRealtimeService } from '../tgcloud/lib/realtime.js';
import { RealtimePeer, createSdkRpc } from '../web/realtime-client.js';

const room = 'a'.repeat(32), clientId = 'b'.repeat(32), guestClient = 'c'.repeat(32);
const context = id => ({ initData: { user: { id } } });
const code = value => error => error.code === value;
const schema = `CREATE TABLE realtime_rooms (room TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, guest_id INTEGER, expires_at INTEGER NOT NULL);
CREATE TABLE realtime_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, room TEXT NOT NULL,
client_id TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX realtime_events_cursor ON realtime_events(room, seq);`;
function setup(t, options = {}) {
  const sql = new DatabaseSync(':memory:'); sql.exec(schema); t.after(() => sql.close());
  const db = {
    async get(query, bindings = {}) { return sql.prepare(query).get(bindings); },
    async all(query, bindings = {}) { return sql.prepare(query).all(bindings); },
    async run(query, bindings = {}) { return { rowsAffected: sql.prepare(query).run(bindings).changes }; },
  };
  const service = createRealtimeService({ db, wait: async () => {}, ...options });
  const call = (op, input = {}, uid = 1) => service({ op, room, ...input }, context(uid));
  const publish = (input = {}, uid = 1) => call('publish', { clientId, requestId: 'first', kind: 'pulse', value: { n: 1 }, ...input }, uid);
  return { sql, service, call, publish };
}

test('only verified context authenticates; room membership is required for read and publish', async t => {
  const { service, call, publish } = setup(t);
  await assert.rejects(service({ op: 'create', room, userId: 1 }, {}), code('AUTH_REQUIRED'));
  await call('create');
  await assert.rejects(call('read', { after: 0, waitMs: 0, userId: 1 }, 2), code('ROOM_UNAVAILABLE'));
  await assert.rejects(publish({}, 2), code('ROOM_UNAVAILABLE'));
  await call('join', {}, 2);
  assert.equal((await publish({}, 2)).event.kind, 'pulse');
});

test('guest slot and idempotent publication survive concurrent requests', async t => {
  const { call, publish, sql } = setup(t);
  await call('create');
  const joined = await Promise.allSettled([call('join', {}, 2), call('join', {}, 3)]);
  assert.equal(joined.filter(x => x.status === 'fulfilled').length, 1);
  const [a, b] = await Promise.all([publish(), publish()]);
  assert.equal(a.event.seq, b.event.seq);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM realtime_events').get().n, 1);
  await assert.rejects(publish({ value: { n: 2 } }), code('ID_REUSED'));
});

test('cursor batches replay every committed event, no duplication after final cursor', async t => {
  const { call, publish } = setup(t); await call('create');
  for (let i = 0; i < 70; i++) await publish({ requestId: 'event_' + i });
  const first = await call('read', { after: 0, waitMs: 0 });
  const resumed = await call('read', { after: first.cursor, waitMs: 0 });
  assert.equal(first.events.length, 64); assert.equal(resumed.events.length, 6);
  assert.equal(new Set([...first.events, ...resumed.events].map(x => x.seq)).size, 70);
  assert.deepEqual((await call('read', { after: resumed.cursor, waitMs: 0 })).events, []);
});

test('ACKs reference existing peer pulses and are idempotent', async t => {
  const { call, publish } = setup(t); await call('create');
  const original = await publish();
  const ack = { kind: 'ack', requestId: 'ack_1', value: { seq: original.event.seq } };
  await assert.rejects(publish(ack), code('INVALID_INPUT'));
  const a = await publish({ ...ack, clientId: guestClient });
  const b = await publish({ ...ack, clientId: guestClient });
  assert.equal(a.event.seq, b.event.seq);
  await assert.rejects(publish({ ...ack, clientId: guestClient, value: { seq: 100 } }), code('INVALID_INPUT'));
});

test('empty wait is bounded even when runtime clock does not advance', async t => {
  let waits = 0;
  const { call } = setup(t, { clock: () => 0, wait: async ms => { assert.equal(ms, 250); waits++; } });
  await call('create');
  assert.deepEqual((await call('read', { after: 0, waitMs: 12000 })).events, []);
  assert.equal(waits, 48);
  await assert.rejects(call('read', { after: 0, waitMs: 45000 }), code('INVALID_INPUT'));
});

test('wait returns after concurrent publication; expired rooms cannot be read or reopened', async t => {
  let publishDuringWait;
  const { call, publish, sql } = setup(t, { wait: async () => { await publishDuringWait(); } });
  await call('create'); publishDuringWait = () => publish();
  assert.equal((await call('read', { after: 0, waitMs: 12000 })).events.length, 1);
  sql.exec('UPDATE realtime_rooms SET expires_at = unixepoch() - 1');
  await assert.rejects(call('join', {}, 2), code('ROOM_UNAVAILABLE'));
  await assert.rejects(publish(), code('ROOM_UNAVAILABLE'));
  await call('create', { room: 'd'.repeat(32) });
  assert.equal(sql.prepare('SELECT count(*) AS n FROM realtime_events').get().n, 0);
});

test('room creation cap still permits a retry of an existing room', async t => {
  const { call } = setup(t);
  for (const letter of ['a', 'b', 'c', 'd']) await call('create', { room: letter.repeat(32) });
  assert.equal((await call('create')).room, room);
  await assert.rejects(call('create', { room: 'e'.repeat(32) }), code('CREATE_LIMIT'));
});

test('invalid parameters and oversize payloads are rejected before writes', async t => {
  const { call, publish } = setup(t); await call('create');
  await assert.rejects(publish({ value: 'x'.repeat(1025) }), code('INVALID_INPUT'));
  await assert.rejects(publish({ clientId: '<script>' }), code('INVALID_INPUT'));
  await assert.rejects(call('read', { after: -1, waitMs: 0 }), code('INVALID_INPUT'));
});

test('client retries an uncertain commit with the same request ID', async t => {
  const { call, service, sql } = setup(t); await call('create');
  let lost = true;
  const peer = new RealtimePeer({ room, clientId, delay: async () => {}, rpc: async input => {
    const result = await service(input, context(1));
    if (lost) { lost = false; throw new Error('Response lost after commit'); }
    return result;
  } });
  assert.equal((await peer.publish('pulse', { n: 1 }, 'stable')).event.seq, 1);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM realtime_events').get().n, 1);
});

test('pause/resume does not overlap reads or consume a response delivered while paused', async () => {
  const reads = [], seen = [];
  const peer = new RealtimePeer({ room, clientId, rpc: input => new Promise(resolve => reads.push({ input, resolve })),
    onEvent: event => { seen.push(event.seq); peer.stop(); } });
  const first = peer.start(); peer.stop(); peer.start();
  assert.equal(reads.length, 1);
  peer.stop(); reads[0].resolve({ events: [{ seq: 1, kind: 'ack' }] }); await first;
  assert.equal(peer.cursor, 0);
  const second = peer.start(); assert.equal(reads[1].input.after, 0);
  reads[1].resolve({ events: [{ seq: 1, kind: 'ack' }] }); await second;
  assert.deepEqual(seen, [1]); assert.equal(peer.cursor, 1);
});

test('cursor is committed only after ACK publication, so reconnect retries the receipt', async () => {
  let acked = false, publications = 0;
  const peer = new RealtimePeer({ room, clientId, delay: async () => {}, rpc: async input => {
    if (input.op === 'publish') {
      publications++;
      assert.equal(peer.cursor, 0);
      if (publications < 3) throw new Error('offline');
      acked = true; return {};
    }
    return { events: [{ seq: 7, kind: 'pulse', clientId: guestClient }] };
  }, onEvent: () => { assert.equal(acked, true); peer.stop(); } });
  await peer.start(); assert.equal(peer.cursor, 7); assert.equal(publications, 3);
});

test('held-request failures fall back to short polling; auth errors stop', async () => {
  const waits = [];
  const peer = new RealtimePeer({ room, clientId, delay: async () => {}, rpc: async input => {
    waits.push(input.waitMs);
    if (waits.length < 3) throw new Error('gateway error');
    throw Object.assign(new Error('denied'), { type: 'ENDPOINT_ERROR' });
  } });
  await peer.start(); assert.deepEqual(waits, [12000, 12000, 0]); assert.equal(peer.wanted, false);
});

test('SDK observation timeout never launches another call or accepts late callback', async () => {
  let callback, calls = 0;
  const rpc = createSdkRpc({ Serverless: { call: (_name, _input, cb) => { calls++; callback = cb; } } }, 5);
  await assert.rejects(rpc({}), code('OBSERVATION_TIMEOUT'));
  callback(null, { late: true });
  await assert.rejects(rpc({}), code('OBSERVATION_TIMEOUT'));
  assert.equal(calls, 1);
});

test('platform 401 stops without retries; Telegram rate limit delay is respected', async () => {
  let calls = 0;
  const rpc = createSdkRpc({ Serverless: { call: (_name, _input, cb) => {
    calls++; cb({ status: 401, message: 'Invalid init data' });
  } } });
  const denied = new RealtimePeer({ room, clientId, rpc });
  await denied.start(); assert.equal(calls, 1); assert.equal(denied.wanted, false);
  const delays = [];
  const limited = new RealtimePeer({ room, clientId, delay: async ms => delays.push(ms), rpc: async () => {
    if (!delays.length) throw Object.assign(new Error('rate limited'), { status: 429, retryAfter: 12 });
    return { event: {} };
  } });
  await limited.publish('pulse', {}); assert.deepEqual(delays, [12000]);
});
