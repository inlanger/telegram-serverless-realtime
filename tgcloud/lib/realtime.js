// A bounded, durable two-user event room. Transport only; no game dependencies.
export class RealtimeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new RealtimeError(code, message); };
const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const eventKey = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const memberSql = `(owner_id = :uid OR guest_id = :uid) AND expires_at > unixepoch()`;
const MAX_EVENTS = 2000;

export function createRealtimeService({ db, wait, clock = Date.now }) {
  async function member(room, uid) {
    const row = await db.get(`SELECT room, owner_id, guest_id, expires_at FROM realtime_rooms
      WHERE room = :room AND ${memberSql}`, { ':room': room, ':uid': uid });
    if (!row) fail('ROOM_UNAVAILABLE', 'The room is unavailable or has expired.');
    return row;
  }
  function view(row, uid) {
    return { room: row.room, expiresAt: row.expires_at * 1000,
      role: row.owner_id === uid ? 'owner' : 'guest' };
  }
  function event(row) {
    return { seq: row.seq, clientId: row.client_id, requestId: row.request_id,
      kind: row.kind, value: JSON.parse(row.payload) };
  }
  return async function realtime(input, ctx) {
    // Only the platform-verified context supplies identity. Ignore input.userId.
    const uid = ctx?.initData?.user?.id;
    if (!Number.isSafeInteger(uid) || uid <= 0) fail('AUTH_REQUIRED', 'Open this demo inside Telegram.');
    if (!input || !id(input.room)) fail('INVALID_INPUT', 'Invalid room.');
    const bindings = { ':room': input.room, ':uid': uid };

    if (input.op === 'create') {
      await db.run('DELETE FROM realtime_events WHERE room IN (SELECT room FROM realtime_rooms WHERE expires_at <= unixepoch())');
      await db.run('DELETE FROM realtime_rooms WHERE expires_at <= unixepoch()');
      await db.run(`INSERT INTO realtime_rooms (room, owner_id, expires_at)
        SELECT :room, :uid, unixepoch() + 3600
        WHERE (SELECT COUNT(*) FROM realtime_rooms WHERE owner_id = :uid) < 4
        ON CONFLICT(room) DO NOTHING`, bindings);
      const row = await db.get(`SELECT room, owner_id, guest_id, expires_at FROM realtime_rooms
        WHERE room = :room AND owner_id = :uid`, bindings);
      if (!row) fail('CREATE_LIMIT', 'Could not create a room. Each owner can have four active one-hour rooms.');
      return view(row, uid);
    }
    if (input.op === 'join') {
      // Concurrent invitations can claim only one guest slot, atomically.
      await db.run(`UPDATE realtime_rooms SET guest_id = :uid WHERE room = :room
        AND expires_at > unixepoch() AND owner_id != :uid AND (guest_id IS NULL OR guest_id = :uid)`, bindings);
      return view(await member(input.room, uid), uid);
    }
    await member(input.room, uid);
    if (input.op === 'publish') {
      if (!id(input.clientId) || !eventKey(input.requestId) || !['pulse', 'ack'].includes(input.kind)) {
        fail('INVALID_INPUT', 'Invalid event.');
      }
      const payload = JSON.stringify(input.value ?? null);
      if (payload.length > 1024) fail('INVALID_INPUT', 'The event is too large.');
      if (input.kind === 'ack') {
        if (!Number.isSafeInteger(input.value?.seq) || input.value.seq < 1) fail('INVALID_INPUT', 'Invalid acknowledgement.');
        const original = await db.get(`SELECT seq FROM realtime_events
          WHERE room = :room AND seq = :seq AND kind = 'pulse' AND client_id != :client`,
        { ':room': input.room, ':seq': input.value.seq, ':client': input.clientId });
        if (!original) fail('INVALID_INPUT', 'The original event does not exist.');
      }
      const key = `${input.room}/${uid}/${input.clientId}/${input.requestId}`;
      await db.run(`INSERT INTO realtime_events (event_key, room, client_id, request_id, kind, payload)
        SELECT :key, :room, :client, :request, :kind, :payload
        WHERE EXISTS (SELECT 1 FROM realtime_rooms WHERE room = :room AND ${memberSql})
          AND (SELECT COUNT(*) FROM realtime_events WHERE room = :room) < ${MAX_EVENTS}
        ON CONFLICT(event_key) DO NOTHING`, { ...bindings, ':key': key, ':client': input.clientId,
        ':request': input.requestId, ':kind': input.kind, ':payload': payload });
      const row = await db.get('SELECT * FROM realtime_events WHERE event_key = :key', { ':key': key });
      if (!row) fail('ROOM_FULL', 'The event limit was reached or the room closed. Create a new room.');
      if (row.kind !== input.kind || row.payload !== payload) fail('ID_REUSED', 'This request ID already belongs to a different event.');
      return { event: event(row) };
    }
    if (input.op === 'read') {
      if (!Number.isSafeInteger(input.after) || input.after < 0 || ![0, 12000].includes(input.waitMs)) {
        fail('INVALID_INPUT', 'Invalid cursor or wait duration.');
      }
      const started = clock();
      // Hard iteration and refreshed wall-clock bounds. Date.now is cached until SDK I/O.
      for (let attempt = 0; attempt <= 48; attempt++) {
        const rows = await db.all(`SELECT seq, client_id, request_id, kind, payload FROM realtime_events
          WHERE room = :room AND seq > :after ORDER BY seq LIMIT 64`,
        { ':room': input.room, ':after': input.after });
        if (rows.length || !input.waitMs || clock() - started >= input.waitMs || attempt === 48) {
          return { events: rows.map(event), cursor: rows.at(-1)?.seq ?? input.after };
        }
        await wait(250);
      }
    }
    fail('INVALID_INPUT', 'Unknown operation.');
  };
}
