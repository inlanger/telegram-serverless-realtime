import { db, EndpointError } from 'sdk';
import { createRealtimeService, RealtimeError } from '../lib/realtime.js';

const buffer = new Int32Array(new SharedArrayBuffer(4));
const service = createRealtimeService({ db, wait: ms => Atomics.wait(buffer, 0, 0, ms) });

export default async function realtime(input, ctx) {
  try { return await service(input, ctx); }
  catch (error) {
    if (error instanceof RealtimeError) throw new EndpointError(error.message, { code: error.code });
    throw error;
  }
}
