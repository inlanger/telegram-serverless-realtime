# Combined exchange experiment

`combined.mjs` wraps the same durable service to process up to eight publications
and then read available events in one request. `receiver.mjs` serializes applying
overlapping prefix responses and skips already-applied sequence numbers.

```js
const exchange = createCombinedExchange(service);
const result = await exchange({
  room, clientId, after: lastAppliedCursor, waitMs: 0,
  outbox: [
    { requestId: 'command-1', kind: 'pulse', value: { x: 1 } },
    { requestId: 'ack-17', kind: 'ack', value: { seq: 17 } },
  ],
}, ctx);
// result: { receipts, events, cursor }
```

When an outbox is nonempty, the read does not wait before returning publication
receipts. When it is empty, `waitMs` may be `0` or `12000`.

This is **not an atomic batch**. A failure can leave an already-committed prefix;
retry stable IDs with identical payloads. The receiver advances only after an
application handler succeeds, but it does not guarantee exactly-once effects
across a process crash.

Run `node --test experiments/combined-exchange/protocol.test.mjs` from the root.
The eight tests are also included in `npm test`.

[Historical measurements](../../docs/verification.md#combined-exchange--october-11-2026)
compare equivalent sequential work. SQL counts are unchanged. This adapter is
not integrated into the browser demo and is outside the deployable `tgcloud/`
folder; there is no public combined endpoint by default.
