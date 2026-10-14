# Verification

Published evidence separates local correctness, cloud behavior and physical-device
measurements. These establish different things.

## Standalone extraction — October 14, 2026

All **14 service/client tests passed**. Both
[Chromium](evidence/standalone-chromium.json) and
[Linux WebKit](evidence/standalone-webkit.json) passed the seven browser scenarios.
These are local correctness checks with a mock bridge; latency numbers have been
omitted from the standalone reports to avoid confusing them with Telegram results.

`npm test` covers the service and client
using Node's real SQLite database. `npm run test:browser` runs two browser clients
against that service with a mock Telegram SDK bridge. Local browser reports and
screenshots go to ignored `test-results/`.

The browser scenarios cover invitation launch parameters, ten pulses and ACKs,
pause/catch-up, cursor persistence on reload, short polling, rejection of a third
user and narrow/landscape layout. The test's configured bot and identities are
synthetic, and the test does not contact Telegram.

The extraction changes error/UI language to English, replaces the original bot
link with public configuration, and handles Main Mini App invitations directly
on the index page. The durable service and default polling algorithm are retained.
[Original source hashes](evidence/extraction.json) identify the pre-extraction
working-tree files; they are not hashes of the translated files.

## Original lab — October 11, 2026

[Raw cloud report](evidence/historical-cloud-1791740161791_ac282e0a.json): seven
successful management API calls, synthetic context, with temporary test tables.
Checks included concurrent guest admission, idempotency, changed-payload rejection,
access control, cross-invocation delivery, cursor replay and a bounded empty read.
The empty read took 12,491 ms client-observed time, including request overhead;
this is not message-delivery latency. Cleanup verified that no test tables remained.

[Chromium](evidence/historical-browser-results.json) and
[Linux WebKit](evidence/historical-browser-results-webkit.json) used a mock bridge
and real local SQLite. Their displayed round-trip values belong to that local
test setup and must not be advertised as Telegram network measurements.

## Still unverified

- Positive signed `/api` round trips from physical Telegram clients.
- Latency distributions on iOS/Android, mobile networks and network changes.
- Production endpoint quotas, high-concurrency behavior and sustained cost.
- Server cancellation when a client closes a request.
- The standalone project's independent deployment.

No live bot was deployed or load-tested while preparing this repository. Exported
device measurements should not contain launch data, user IDs, room invites or
credentials. Review files before sharing them.
