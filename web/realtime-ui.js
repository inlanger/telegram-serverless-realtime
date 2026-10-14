import { RealtimePeer, createSdkRpc, newId } from './realtime-client.js';
import { BOT_USERNAME } from './config.js';

const webApp = globalThis.Telegram?.WebApp;
const $ = id => document.getElementById(id);
const error = cause => { $('error').textContent = cause.message || String(cause); $('error').hidden = false; };
const configured = /^[a-zA-Z0-9_]{5,32}$/.test(BOT_USERNAME) && BOT_USERNAME !== 'YOUR_BOT_USERNAME';
const entry = `https://t.me/${BOT_USERNAME}?startapp=rt`;
let peer, manuallyPaused = false, sending = false, flashTimer;
let received = 0, sent = 0;
const pending = new Map(), own = new Map(), samples = [], rows = [];
const rpcStats = { calls: 0, errors: 0, maxMs: 0 };

function record(text) {
  rows.push({ at: new Date().toISOString(), text });
  if (rows.length > 200) rows.shift();
  const li = document.createElement('li'); li.textContent = text;
  $('events').prepend(li);
  while ($('events').children.length > 15) $('events').lastElementChild.remove();
}
function controls() {
  $('send').disabled = $('burst').disabled = sending || manuallyPaused || !peer?.wanted;
  $('pause').textContent = manuallyPaused ? 'Resume receiving' : 'Pause receiving';
  $('mode').value = peer?.mode || 'long';
  $('counters').textContent = `Sent: ${sent}. Acknowledged: ${samples.length}. Cursor: ${peer?.cursor || 0}. Requests: ${rpcStats.calls}. Errors: ${rpcStats.errors}.`;
}
function state(name, cause) {
  $('status').textContent = ({ connected: 'Receiving', reconnecting: 'Reconnecting…', paused: 'Receiving paused', error: 'Receiving stopped' })[name];
  if (name === 'error') error(cause);
  controls();
}
async function receive(event) {
  if (event.clientId === peer.clientId && event.kind === 'pulse') own.set(event.seq, event.requestId);
  if (event.clientId !== peer.clientId && event.kind === 'pulse') {
    received++; $('received').textContent = received;
    $('signal-text').textContent = 'Pulse received';
    $('signal').classList.add('flash'); clearTimeout(flashTimer);
    flashTimer = setTimeout(() => $('signal').classList.remove('flash'), 500);
    record(`Received and acknowledged #${event.seq}`);
  }
  if (event.kind === 'ack' && event.clientId !== peer.clientId) {
    const requestId = own.get(event.value.seq), started = pending.get(requestId);
    if (started !== undefined) {
      const elapsed = Math.round(performance.now() - started);
      pending.delete(requestId); samples.push(elapsed);
      $('roundtrip').textContent = elapsed;
      const sorted = [...samples].sort((a, b) => a - b);
      $('percentile').textContent = sorted[Math.ceil(sorted.length * .95) - 1];
      record(`Acknowledgement #${event.value.seq}: ${elapsed} ms round trip`);
    }
  }
  controls();
}
async function connect(room, create = false) {
  $('error').hidden = true;
  const sdkRpc = createSdkRpc(webApp);
  const rpc = async input => {
    const started = performance.now(); rpcStats.calls++;
    try { return await sdkRpc(input); }
    catch (cause) { rpcStats.errors++; throw cause; }
    finally { rpcStats.maxMs = Math.max(rpcStats.maxMs, Math.round(performance.now() - started)); }
  };
  let saved;
  // Optional browser session cache only. Failure is harmless: replay starts at zero.
  const storageKey = 'realtime-lab:' + room;
  try { saved = JSON.parse(sessionStorage.getItem(storageKey)); } catch {}
  const clientId = /^[a-f0-9]{32}$/.test(saved?.clientId) ? saved.clientId : newId();
  const cursor = Number.isSafeInteger(saved?.cursor) && saved.cursor >= 0 ? saved.cursor : 0;
  const persist = value => { try { sessionStorage.setItem(storageKey, JSON.stringify({ clientId, cursor: value })); } catch {} };
  peer = new RealtimePeer({ rpc, room, clientId, cursor, onEvent: receive, onState: state,
    saveCursor: value => { persist(value); controls(); } });
  await peer.request({ op: create ? 'create' : 'join' });
  persist(cursor);
  const url = new URL(location.href); url.searchParams.set('room', room); history.replaceState(null, '', url);
  $('setup').hidden = true; $('session').hidden = false;
  $('invite').value = entry + '_' + room;
  $('room-label').textContent = 'Room ' + room.slice(0, 6);
  $('auth').textContent = 'Telegram verified your account. The room is open.';
  if (!document.hidden) peer.start();
  controls();
}
async function send(count) {
  if (sending || !peer?.wanted || manuallyPaused) return;
  sending = true; controls(); $('error').hidden = true;
  try {
    for (let index = 0; index < count; index++) {
      if (document.hidden || !peer.wanted || manuallyPaused) break;
      const requestId = newId(); pending.set(requestId, performance.now());
      const result = await peer.publish('pulse', { number: sent + 1 }, requestId);
      own.set(result.event.seq, requestId); sent++;
      record(`Sent #${result.event.seq}, awaiting acknowledgement`);
    }
  } catch (cause) { error(cause); }
  finally { sending = false; controls(); }
}
$('send').onclick = () => send(1);
$('burst').onclick = () => send(10);
$('pause').onclick = () => {
  manuallyPaused = !manuallyPaused;
  if (manuallyPaused) peer.stop(); else if (!document.hidden) peer.start();
  controls();
};
$('mode').onchange = () => { peer.mode = $('mode').value; };
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('invite').value); $('copy').textContent = 'Link copied'; }
  catch { $('invite').focus(); $('invite').select(); $('copy').textContent = 'Copy the selected link'; }
};
$('download').onclick = () => {
  // No initData, user IDs, room invitation or credentials in the downloadable report.
  const result = { version: 1, transport: peer?.mode, platform: webApp?.platform, sdkVersion: webApp?.version,
    measurement: 'One-device performance.now(): send -> other client receipt -> ACK -> sender receipt; not one-way latency',
    sent, received, roundTripMs: samples, rpc: rpcStats, events: rows };
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'telegram-realtime-results.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
document.addEventListener('visibilitychange', () => {
  if (!peer) return;
  if (document.hidden) peer.stop(); else if (!manuallyPaused) peer.start();
});
if (!configured) {
  $('auth').textContent = 'Set your public bot username in web/config.js, then deploy the demo.';
} else if (!webApp?.initData || !webApp?.Serverless?.call) {
  $('auth').textContent = 'Open this demo inside Telegram.';
  const link = document.createElement('a'); link.href = entry; link.textContent = 'Open Telegram Realtime Lab';
  $('auth').append(document.createElement('br'), link);
} else {
  webApp.ready(); webApp.expand(); webApp.BackButton?.hide();
  $('auth').textContent = 'Telegram supplied launch data. The server will verify it when you connect.';
  const query = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.slice(1));
  // Launch parameters select a room; identity is always checked by the endpoint.
  const start = webApp.initDataUnsafe?.start_param || query.get('tgWebAppStartParam') || fragment.get('tgWebAppStartParam') || '';
  const room = /^rt_[a-f0-9]{32}$/.test(start) ? start.slice(3) : query.get('room');
  if (/^[a-f0-9]{32}$/.test(room || '')) connect(room).catch(error);
  else {
    $('setup').hidden = false;
    let draftRoom;
    $('create').onclick = async () => {
      $('create').disabled = true;
      // Same invitation key on retry if the initial response was lost.
      draftRoom ||= newId();
      try { await connect(draftRoom, true); }
      catch (cause) { error(cause); $('create').disabled = false; }
    };
  }
}
