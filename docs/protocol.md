# Protocol and operational limits

All operations go through `Telegram.WebApp.Serverless.call('realtime', input, callback)`.
The platform verifies launch data before calling the endpoint. Only
`ctx.initData.user.id` establishes identity; input fields cannot replace it.

## Operations

| Operation | Required fields besides `op` | Response |
| --- | --- | --- |
| `create` | `room` | `{room, expiresAt, role}` |
| `join` | `room` | `{room, expiresAt, role}` |
| `publish` | `room, clientId, requestId, kind, value` | `{event}` |
| `read` | `room, after, waitMs` | `{events, cursor}` |

`room` and `clientId` are 32 lowercase hexadecimal characters. The demo generates
them using browser `crypto.randomUUID()`. A `requestId` has 1–64 ASCII letters,
digits, underscores or hyphens. `after` is a nonnegative safe integer.
`waitMs` must be `0` or `12000`.

The two diagnostic event types are `pulse` and `ack`. A pulse carries JSON; an ACK
carries `{seq}` referring to an existing pulse whose client ID differs from the
ACK's client ID. Each returned event contains `seq`, `clientId`, `requestId`,
`kind` and `value`. User IDs are not returned in events.

```js
import { RealtimePeer, createSdkRpc, newId } from './web/realtime-client.js';

const room = newId(); // Share this only with the invited participant.
const peer = new RealtimePeer({
  rpc: createSdkRpc(Telegram.WebApp),
  room,
  onEvent: event => console.log(event.kind, event.seq),
});
await peer.request({ op: 'create' }); // Use 'join' on the other device.
peer.start();
await peer.publish('pulse', { message: 'hello' });
// peer.stop() stops new reads; it cannot cancel a server invocation.
```

## Delivery and retries

The publication key includes the room, verified user ID, client ID and request ID.
Retrying the same key and payload returns the existing event. Reusing it with
different content fails. Deduplication compares serialized JSON, so retries must
preserve the payload rather than rebuilding a different representation.

Events are ordered by SQLite sequence number. Sequence numbers can have gaps,
including from deduplicated inserts, so readers use `seq > after` rather than
expecting contiguous numbers. A read returns up to 64 events.

The client writes a diagnostic ACK before invoking `onEvent` for a remote pulse,
then advances and saves its cursor after that callback succeeds. An ACK therefore
means the receiving client observed the pulse, not that application side effects
completed. A crash between processing and cursor persistence can replay an event;
application handlers need their own idempotency where effects matter.

Optional `sessionStorage` preserves client ID and cursor within a browser tab.
Unavailable storage starts replay from zero. Room access never depends on local
storage. Call `stop()` on the old peer before replacing a client instance.

Writes retry up to four attempts with stable IDs and bounded exponential delays.
Read errors back off; after two consecutive failures the listener switches to
short polling. Terminal endpoint errors and authentication errors stop receiving.
Retry-after values are respected up to the client's 60-second delay cap.

If the official SDK does not call back within 45 seconds, the RPC adapter stops
accepting calls until reload. The timeout is an observation limit, not server
cancellation. A pending operation may already have committed.

## Waiting cost

The cloud endpoint uses `Atomics.wait` between asynchronous SQLite calls. This
runtime-specific technique was observed in the original lab; it is not a
documented subscription API or a general-purpose server sleep primitive.

Each read checks membership once, then runs at most 49 event queries with at most
48 waits of 250 ms. The wall-clock budget is checked after SDK I/O because the
observed runtime clock did not advance during synchronous work. Query/network
time can make the actual response take longer than 12 seconds.

An idle listener costs roughly four event reads per second; two listeners cost
roughly eight, plus membership/request-boundary reads. A short-poll request costs
one membership read and one event read; the default client waits 500 ms after an
empty response. Short polling trades shorter invocations for more HTTP calls.

## Access and retention

An invitation admits the first other user atomically. The owner may also join
from another device. Four active rooms per owner, one-hour expiry, 2,000 stored
events per room, and a 1,024-code-unit serialized JSON limit bound normal use.
ACKs consume the same event budget as pulses.

The room ID is an invitation capability. A device/client ID is not an identity
credential and may be chosen by either room member. Do not use receipt counts as
anti-cheat proof or proof of another person's identity.

Expired rows are pruned when a room is created. There is no scheduler or immediate
expiry deletion. An admitted read may remain pending briefly across expiry;
membership is checked when the read starts. No per-user request rate limiter or
server-side concurrent-reader cap is implemented. This is a bounded test demo,
not an abuse-resistant public messaging service.
