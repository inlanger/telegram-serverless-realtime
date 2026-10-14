# Research context

Checked October 14, 2026. This project demonstrates one available near-realtime
path, rather than claiming that polling is the only possible design.

The [official endpoint contract](https://core.telegram.org/bots/serverless#endpoints)
accepts and returns JSON. The [official browser SDK](https://telegram.org/js/telegram-web-app.js)
performs a POST, reads the complete response and parses it. Outbound
[SDK fetch](https://core.telegram.org/bots/serverless#http) can consume SSE, but
that does not provide a stream from an endpoint into a browser. No documented
DB change subscription or arbitrary endpoint-to-Mini-App push API was found.

## What other developers have published

- [chethober/games](https://github.com/chethober/games/blob/5506410f658aaeb22b242f996f0e98a7b87426e5/public/js/app.js#L194)
  uses Telegram Serverless for multiplayer rooms. Its inspected browser loop
  waits two seconds after each state read; it is polling, not a new push channel.
- [Pitgram](https://github.com/raghavbali/pitgram/blob/main/relay/docs/architecture.md)
  stores incoming bot updates and polls them through the management API from a
  local agent. It does not offer a browser event subscription.
- [@tma.js/sdk](https://github.com/Telegram-Mini-Apps/telegram-apps/blob/fa9a3ffc78ea2afe132d667805368e26ef5f26e9/packages/sdk/src/components/serverless/serverless.ts)
  supports browser AbortSignal, but still parses a complete JSON response. Browser
  cancellation is not evidence that a server-side SQL loop stopped.
- [Independent capacity measurements](https://github.com/DaYzTm/telegram-serverless-limits/blob/main/reports/capacity.md)
  observed roughly three seconds of uninterrupted CPU work and management-route
  throttling. The report explicitly distinguishes these from waiting duration
  and production endpoint throughput. They are not official quotas.
- [A WebRTC Mini App template](https://github.com/cherya/tg-miniapp-template/blob/f8a49b155f913cf41379569155284324600590b2/README.md#adding-multiplayer)
  proposes signaling followed by a DataChannel, using Cloudflare and Google STUN.
  At the inspected commit the proposed signaling/WebRTC modules were absent;
  the README is not proof of a completed Telegram Serverless transport.

## Alternatives and open work

WebRTC can move client-to-client traffic off the database after signaling. Actual
Telegram-device connectivity still needs testing; [TURN](https://webrtc.org/getting-started/turn-server)
is needed where a direct route fails. A browser P2P channel does not independently
let a backend push a completed job to a client. An external WebSocket/SSE relay
can provide that channel, but introduces infrastructure outside Telegram.

No new reproducible Telegram-only push mechanism was found in the reviewed public
sources. Private discussions and unindexed implementations remain outside that
claim. Contributions with code and clearly scoped measurements are welcome.
