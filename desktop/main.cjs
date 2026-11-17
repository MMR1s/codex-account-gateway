'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { BrowserWorkspace } = require('./browser.cjs');
const { CodexAgent } = require('./agent.cjs');
const { BrowserBroker } = require('./broker.cjs');
const { ActionPermissions } = require('./action-permissions.cjs');
const { SiteApi } = require('./site-api.cjs');

const stateDir = process.env.CODEX_BROWSER_STATE_DIR || process.env.CODEX_GATEWAY_STATE_DIR || path.join(__dirname, '../.runtime/state');
fs.mkdirSync(stateDir, { recursive: true });
const actionPermissions=new ActionPermissions(stateDir);
app.setPath('userData', path.join(stateDir, 'browser-profile'));
const descriptor = path.join(stateDir, 'browser-session.json');
let win, browser, broker, agent, agentReady, server, quitting = false, chatGeneration = 0;
const events = [];
function emit(type, data) {
  if (type === 'agent') { events.push({ type, data }); if (events.length > 100) events.shift(); }
  if (win && !win.isDestroyed()) win.webContents.send('workspace-event', { type, data });
}
async function gatewayStatus() {
  try {
    const r = await fetch('http://127.0.0.1:4000/health', { signal: AbortSignal.timeout(2500) }); const value = await r.json();
    return { online: value.service === 'dual-account-local', active: value.active };
  } catch { return { online: false }; }
}
async function getAgent() {
  if (!agent) {
    const cwd = path.join(stateDir, 'browser-agent'); fs.mkdirSync(cwd, { recursive: true });
    agent = new CodexAgent({ browser, broker, emit, cwd });
    agentReady = agent.start().catch(e => { agent?.close(); agent = null; agentReady = null; throw e; });
  }
  await agentReady;
  return agent;
}
async function routeAction(action) {
  return broker.submit(action);
}
function reply(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function apiServer() {
  const token = randomBytes(32).toString('hex');
  server = http.createServer(async (req, res) => {
    // Cross-origin browser pages cannot use this private control channel.
    if (req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) return reply(res, 403, { error: 'Local application access only.' });
    const supplied = req.headers.authorization || '';
    const expected = `Bearer ${token}`;
    if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return reply(res, 401, { error: 'Browser credential required.' });
    try {
      if (req.method === 'GET' && req.url === '/state') return reply(res, 200, { running: true, ...browser.state(), actionPermissions:actionPermissions.state(), agentBusy: !!agent?.busy });
      if (req.method === 'GET' && req.url.startsWith('/events')) {
        const url = new URL(req.url, 'http://127.0.0.1'); return reply(res, 200, broker.since(Number(url.searchParams.get('after')) || 0));
      }
      if (req.method === 'GET' && req.url.startsWith('/requests/')) {
        const url = new URL(req.url, 'http://127.0.0.1'); return reply(res, 200, broker.get(url.searchParams.get('clientId') || 'local-app', decodeURIComponent(url.pathname.slice('/requests/'.length))));
      }
      if (req.method === 'GET' && req.url.startsWith('/approvals/')) return reply(res, 200, browser.approvalResult(req.url.split('/').pop()));
      if (req.method === 'POST' && req.url === '/control') {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 60000) throw Error('Request too large.'); }
        const result = await routeAction(JSON.parse(body)); return reply(res, result.pendingApproval || ['running','awaiting-approval'].includes(result.state) ? 202 : 200, result);
      }
      reply(res, 404, { error: 'Unknown browser endpoint.' });
    } catch (error) { reply(res, 400, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(descriptor, JSON.stringify({ port: server.address().port, token, pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
}
function trusted(event) {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw Error('Untrusted workspace caller.');
}
function handle(channel, fn) { ipcMain.handle(channel, async (event, arg) => { trusted(event); return fn(arg); }); }

async function createWindow() {
  win = new BrowserWindow({ width: 1480, height: 940, minWidth: 1000, minHeight: 650, title: 'Codex Relay — Browser Workspace', backgroundColor: '#111116', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\/developers\.openai\.com\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', event => event.preventDefault());
  const browserSession = session.fromPartition('persist:relay-general-browser');
  browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  browser = new BrowserWorkspace({ window: win, View: WebContentsView, browserSession, emit });
  browser.api = new SiteApi({browser,stateDir,emit});
  broker = new BrowserBroker(browser,actionPermissions);
  handle('action-permissions', input => input ? actionPermissions.update(input) : actionPermissions.state());
  handle('workspace-state', async () => ({ browser: browser.state(), gateway: await gatewayStatus(), agent: { ready: !!agent, busy: !!agent?.busy, models: agent?.models || [] }, events }));
  handle('browser-action', action => browser.execute(action)); // Direct human browser controls.
  handle('browser-bounds', bounds => { browser.setBounds(bounds); return true; });
  handle('browser-approval', ({ id, approved }) => browser.decide(id, approved === true));
  handle('agent-connect', () => getAgent().then(a => ({ ready: true, models: a.models })));
  handle('agent-chat', async input => { const generation = ++chatGeneration; const a = await getAgent(); if (generation !== chatGeneration) throw Error('Browser task was cancelled.'); return a.chat(input); });
  handle('agent-stop', () => { chatGeneration++; return agent?.stop() || { stopped: true }; });
  handle('agent-new', async () => { chatGeneration++; if (agent?.busy) await agent.stop(); agent?.close(); agent = null; agentReady = null; events.length = 0; return getAgent().then(a => ({ ready: true, models: a.models })); });
  await win.loadFile(path.join(__dirname, 'index.html'));
  let urls = ['https://example.com/'];
  try { const stored = JSON.parse(fs.readFileSync(path.join(stateDir, 'browser-tabs.json'), 'utf8')); if (Array.isArray(stored.urls) && stored.urls.length) urls = stored.urls.slice(0, 12); } catch {}
  for (const url of urls) { try { browser.open(url); } catch {} }
  if (!browser.tabs.size) browser.open();
  await apiServer();
  win.show();
  win.on('close', () => {
    const urls = browser.state().tabs.map(t => t.url).filter(u => /^https?:/.test(u)).map(value => { const u = new URL(value); for (const key of ['code','access_token','id_token','refresh_token','token','state']) u.searchParams.delete(key); return u.href; });
    fs.writeFileSync(path.join(stateDir, 'browser-tabs.json'), JSON.stringify({ urls }), { mode: 0o600 });
    quitting = true; agent?.close(); server?.close(); browser.destroy();
    try { const owned = JSON.parse(fs.readFileSync(descriptor)); if (owned.pid === process.pid) fs.unlinkSync(descriptor); } catch {}
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(createWindow).catch(error => { console.error(error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { if (!quitting) agent?.close(); });
}
