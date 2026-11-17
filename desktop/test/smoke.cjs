// Opt-in live integration test. Uses an isolated browser profile and a local
// fixture; it never signs into sites or sends messages to real recipients.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const stateDir = path.resolve(__dirname, `../../.runtime/browser-smoke-${process.pid}`);
process.env.CODEX_BROWSER_STATE_DIR = stateDir;
const { app, BrowserWindow } = require('electron');
require('../main.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await sleep(250); } throw Error('Integration check timed out.');
}
let fixture;
(async () => {
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows()[0]);
  await until(() => fs.existsSync(path.join(stateDir, 'browser-session.json')));
  const connection = JSON.parse(fs.readFileSync(path.join(stateDir, 'browser-session.json')));
  async function control(action) {
    const r = await fetch(`http://127.0.0.1:${connection.port}/control`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
    const data = await r.json(); if (!r.ok) throw Error(data.error); return data;
  }
  fixture = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><title>Relay Browser Test</title></head><body style="font-family:system-ui;padding:60px;color:#232333"><h1>Gateway browser is working</h1><p>This is a local test page for the general gateway browser.</p><label>Draft message <input id="draft" placeholder="Write a draft"></label><button id="submit" onclick="document.querySelector(\'#result\').textContent=\'Local action confirmed\'">Confirm local action</button><p id="result">No action yet</p><input type="password" aria-label="Private sign-in field" value="not-a-real-secret"></body></html>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const opened = await control({ action: 'open', url: `http://127.0.0.1:${fixture.address().port}/` });
  await until(async () => (await control({ action: 'snapshot', tabId: opened.tabId })).title === 'Relay Browser Test');
  let snapshot = await control({ action: 'snapshot', tabId: opened.tabId });
  assert.ok(snapshot.text.includes('Gateway browser is working'));
  assert.ok(!snapshot.text.includes('not-a-real-secret'));
  assert.ok(!snapshot.elements.some(e => e.type === 'password'));
  const field = snapshot.elements.find(e => e.tag === 'input');
  const pending = await control({ action: 'fill', tabId: opened.tabId, ref: field.ref, text: 'A local test draft' });
  assert.ok(pending.pendingApproval);
  await win.webContents.executeJavaScript(`window.relay.approve(${JSON.stringify(pending.approvalId)},true)`);
  snapshot = await control({ action: 'snapshot', tabId: opened.tabId });
  const button = snapshot.elements.find(e => e.tag === 'button');
  const click = await control({ action: 'click', tabId: opened.tabId, ref: button.ref });
  await win.webContents.executeJavaScript(`window.relay.approve(${JSON.stringify(click.approvalId)},true)`);
  await until(async () => (await control({ action: 'snapshot', tabId: opened.tabId })).text.includes('Local action confirmed'));
  console.log('PASS: native browser, snapshots, private fields, and approved local actions.');
  const connected = await win.webContents.executeJavaScript('window.relay.connect()');
  assert.ok(connected.ready); console.log('PASS: Codex app-server connected.');
  const prompt = 'Use gateway_browser to take a snapshot of my current tab. Tell me the main heading and the action confirmation text. Do not click, type, navigate, or submit anything.';
  await win.webContents.executeJavaScript(`(() => {document.getElementById('prompt').value=${JSON.stringify(prompt)};document.getElementById('chat-form').requestSubmit();})()`);
  const result = await until(async () => {
    const data = await win.webContents.executeJavaScript('window.relay.state()');
    const error = data.events.find(e => e.data.kind === 'error'); if (error) throw Error(error.data.message);
    const done = data.events.find(e => e.data.kind === 'complete'); if (!done) return false;
    if (done.data.error) throw Error(done.data.error);
    return data;
  }, 180000);
  const toolCalls = result.events.filter(e => e.data.kind === 'tool' && e.data.state === 'complete');
  assert.ok(toolCalls.some(e => e.data.action === 'snapshot'));
  const answer = result.events.filter(e => e.data.kind === 'message').map(e => e.data.text).join('\n');
  assert.match(answer, /Gateway browser is working/i); assert.match(answer, /Local action confirmed/i);
  console.log('PASS: live Codex browser-tool round trip and verified page summary.');
  console.log(JSON.stringify({ provider: result.events.find(e => e.data.kind === 'thread')?.data.provider, model: result.events.find(e => e.data.kind === 'thread')?.data.model, browserToolCalls: toolCalls.length, answer }));
  fs.mkdirSync(path.join(__dirname, '../artifacts'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '../artifacts/smoke-result.json'), JSON.stringify({ passed: true, provider: result.events.find(e => e.data.kind === 'thread')?.data.provider, browserToolCalls: toolCalls.length, answer }, null, 2));
  await sleep(350);
  fs.writeFileSync(path.join(__dirname, '../artifacts/workspace.png'), (await win.webContents.capturePage()).toPNG());
  fixture.close(); app.quit();
})().catch(error => { console.error('FAIL:', error.stack); if (fixture) fixture.close(); app.exit(1); });
