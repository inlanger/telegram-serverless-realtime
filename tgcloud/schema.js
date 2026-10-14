import { table, integer, text, index } from 'sdk/db';

export const realtimeRooms = table('realtime_rooms', {
  room: text('room').primaryKey(),
  ownerId: integer('owner_id').notNull(),
  guestId: integer('guest_id'),
  expiresAt: integer('expires_at').notNull(),
}, t => ({ owner: index('realtime_rooms_owner').on(t.ownerId), expiry: index('realtime_rooms_expiry').on(t.expiresAt) }));

export const realtimeEvents = table('realtime_events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  eventKey: text('event_key').notNull().unique(),
  room: text('room').notNull(),
  clientId: text('client_id').notNull(),
  requestId: text('request_id').notNull(),
  kind: text('kind').notNull(),
  payload: text('payload').notNull(),
}, t => ({ cursor: index('realtime_events_cursor').on(t.room, t.seq) }));
