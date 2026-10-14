// Research adapter over the existing durable service. No new auth or storage model.
// A batch may commit a prefix before a later command fails. Retry stable IDs.
export function createCombinedExchange(service) {
  return async function exchange(input, ctx) {
    if (!input || !Array.isArray(input.outbox) || input.outbox.length > 8 ||
        !Number.isSafeInteger(input.after) || input.after < 0 || ![0, 12000].includes(input.waitMs)) {
      throw Object.assign(new Error('Invalid exchange envelope'), {code: 'INVALID_INPUT'});
    }
    const receipts = [];
    for (const packet of input.outbox) {
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
        throw Object.assign(new Error('Invalid packet'), {code: 'INVALID_INPUT'});
      }
      // Enumerate fields: a packet cannot override room, clientId or operation.
      const response = await service({op: 'publish', room: input.room, clientId: input.clientId,
        requestId: packet.requestId, kind: packet.kind, value: packet.value}, ctx);
      receipts.push({requestId: packet.requestId, seq: response.event.seq});
    }
    // A successful upload receipt is returned promptly, not held behind an idle read.
    const result = await service({op: 'read', room: input.room, after: input.after,
      waitMs: input.outbox.length ? 0 : input.waitMs}, ctx);
    return {...result, receipts};
  };
}
