export const newId = () => crypto.randomUUID().replaceAll('-', '');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const terminal = error => error?.type === 'ENDPOINT_ERROR' || error?.code === 'OBSERVATION_TIMEOUT'
  || (error?.status >= 400 && error.status < 500 && error.status !== 429);
const retryDelay = (error, fallback) => Math.max(fallback, Math.min(60000, (Number(error?.retryAfter) || 0) * 1000));

export function createSdkRpc(webApp, timeoutMs = 45000) {
  let stalled = false;
  return input => new Promise((resolve, reject) => {
    if (stalled) return reject(Object.assign(new Error('A request did not complete. Reload the demo.'), { code: 'OBSERVATION_TIMEOUT' }));
    let settled = false;
    const timer = setTimeout(() => {
      settled = stalled = true;
      // The official SDK has no request cancellation. Never stack new calls on a lost callback.
      reject(Object.assign(new Error('Telegram did not respond in time. Reload the demo.'), { code: 'OBSERVATION_TIMEOUT' }));
    }, timeoutMs);
    try {
      webApp.Serverless.call('realtime', input, (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(Object.assign(new Error(error.status === 401 ? 'Your session expired. Close and reopen the demo in Telegram.' : error.message || 'Connection error'),
          { type: error.type, status: error.status, code: error.parameters?.code, retryAfter: error.parameters?.retry_after }));
        else resolve(result);
      });
    } catch (error) { settled = true; clearTimeout(timer); reject(error); }
  });
}

export class RealtimePeer {
  constructor({ rpc, room, clientId = newId(), cursor = 0, onEvent = () => {}, onState = () => {},
    saveCursor = () => {}, delay = pause }) {
    Object.assign(this, { rpc, room, clientId, cursor, onEvent, onState, saveCursor, delay });
    this.mode = 'long'; this.wanted = false; this.running = null; this.outbox = Promise.resolve();
  }
  async request(input) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await this.rpc({ ...input, room: this.room }); }
      catch (error) {
        last = error;
        if (terminal(error)) throw error;
        if (attempt < 3) await this.delay(retryDelay(error, Math.min(4000, 500 * 2 ** attempt)));
      }
    }
    throw last;
  }
  publish(kind, value, requestId = newId()) {
    // Stable requestId survives uncertain responses and retries; queue bounds concurrency.
    const task = this.outbox.catch(() => {}).then(() => this.request({
      op: 'publish', clientId: this.clientId, requestId, kind, value,
    }));
    this.outbox = task;
    return task;
  }
  start() {
    this.wanted = true;
    if (this.running) return this.running;
    this.running = this.listen().finally(() => {
      this.running = null;
      if (this.wanted) this.start();
    });
    return this.running;
  }
  stop() { this.wanted = false; this.onState('paused'); }
  async listen() {
    let failures = 0;
    while (this.wanted) {
      try {
        this.onState(failures ? 'reconnecting' : 'connected');
        const batch = await this.rpc({ op: 'read', room: this.room, after: this.cursor,
          waitMs: this.mode === 'long' ? 12000 : 0 });
        if (!this.wanted) break; // A paused response must not consume unseen events.
        failures = 0;
        for (const event of batch.events) {
          if (!this.wanted) break;
          if (event.seq <= this.cursor) continue;
          if (event.kind === 'pulse' && event.clientId !== this.clientId) {
            await this.publish('ack', { seq: event.seq }, 'ack_' + event.seq);
          }
          await this.onEvent(event);
          this.cursor = event.seq;
          this.saveCursor(this.cursor);
        }
        if (this.mode === 'short' && !batch.events.length) await this.delay(500);
      } catch (error) {
        if (!this.wanted) break;
        if (terminal(error)) { this.wanted = false; this.onState('error', error); break; }
        failures++;
        this.onState('reconnecting', error);
        // Some /api gateways may reject held requests: switch to bounded short polling.
        if (failures >= 2) this.mode = 'short';
        await this.delay(retryDelay(error, Math.min(8000, 500 * 2 ** Math.min(failures, 4))));
      }
    }
  }
}
