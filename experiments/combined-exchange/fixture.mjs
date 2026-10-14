import {DatabaseSync} from 'node:sqlite';
import {createRealtimeService} from '../../tgcloud/lib/realtime.js';
import {createCombinedExchange} from './combined.mjs';
export const room = 'a'.repeat(32), clientA = 'b'.repeat(32), clientB = 'c'.repeat(32);
export const context = uid => ({initData: {user: {id: uid}}});
export function fixture(wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE realtime_rooms(room TEXT PRIMARY KEY,owner_id INTEGER NOT NULL,guest_id INTEGER,expires_at INTEGER NOT NULL);
    CREATE TABLE realtime_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT UNIQUE NOT NULL,room TEXT NOT NULL,
    client_id TEXT NOT NULL,request_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX realtime_events_cursor ON realtime_events(room,seq);`);
  sql.prepare('INSERT INTO realtime_rooms VALUES (?,1,2,unixepoch()+3600)').run(room);
  const counts = {reads: 0, writes: 0};
  const db = {
    async get(query, bindings = {}) {counts.reads++; return sql.prepare(query).get(bindings);},
    async all(query, bindings = {}) {counts.reads++; return sql.prepare(query).all(bindings);},
    async run(query, bindings = {}) {counts.writes++; return {rowsAffected: sql.prepare(query).run(bindings).changes};},
  };
  const service = createRealtimeService({db, wait});
  return {sql, counts, service, exchange: createCombinedExchange(service),
    publish: (requestId, value = {}, clientId = clientB, uid = 2) =>
      service({op: 'publish', room, clientId, requestId, kind: 'pulse', value}, context(uid)),
    read: (after = 0, waitMs = 0) => service({op: 'read', room, after, waitMs}, context(1)),
    close: () => sql.close()};
}
