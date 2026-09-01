/* Drive headless Chrome through the DevTools protocol and wait for the benchmark to finish.
 *
 * `--dump-dom` and `--virtual-time-budget` were both tried first and both fail the same
 * way: they snapshot the page at a moment of Chrome's choosing, and a benchmark that is
 * still folding looks identical to a browser that cannot run the module. A silent empty
 * result is the worst possible outcome for a measurement, so this waits for the page to
 * say it is done and reads the value out of the page itself.
 *
 * No dependencies: node 18+ has fetch and node 22+ has a global WebSocket, and CDP is a
 * websocket that speaks JSON.
 *
 *   node tools/bench/drive_chrome.mjs http://127.0.0.1:8099/tools/bench/index.html?auto=1
 */

const url = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? 1_800_000);
if (!url) {
  console.error('usage: node drive_chrome.mjs <url> [timeoutMs]');
  process.exit(2);
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9222 + Math.floor(Math.random() * 500);

const { spawn } = await import('node:child_process');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const profile = mkdtempSync(join(tmpdir(), 'buttfold-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  // A benchmark in a background headless tab is exactly what these two throttle.
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderr = '';
chrome.stderr.on('data', d => { stderr += d.toString(); });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`Chrome never opened a debugging port.\n${stderr.slice(-2000)}`);
}

const ws = new WebSocket(await endpoint());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let nextId = 1;
const pending = new Map();
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? []).map(a => a.value ?? a.description).join(' ');
    if (text) console.error(`  [page] ${text.slice(0, 300)}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    console.error(`  [page error] ${msg.params.exceptionDetails?.exception?.description}`);
  }
};

function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send('Page.navigate', { url }, sessionId);

const started = Date.now();
let payload = null;
while (Date.now() - started < timeoutMs) {
  await sleep(2000);
  const { result } = await send('Runtime.evaluate', {
    expression: 'window.__buttfoldP02 ? JSON.stringify(window.__buttfoldP02) : null',
    returnByValue: true,
  }, sessionId);
  if (result.value) { payload = JSON.parse(result.value); break; }
}

chrome.kill();
if (!payload) {
  console.error(`benchmark did not finish within ${timeoutMs} ms`);
  process.exit(1);
}
console.log(JSON.stringify(payload, null, 1));
