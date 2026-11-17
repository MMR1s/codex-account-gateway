const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAction, webUrl } = require('../policy.cjs');
const { BrowserWorkspace } = require('../browser.cjs');
function workspace() {
  const b = new BrowserWorkspace({ window: {}, View: null, browserSession: null, emit: () => {} });
  b.tabs.set('tab1', { id: 'tab1', view: { webContents: { getURL: () => 'https://example.com/', getTitle: () => 'Example', isLoading: () => false } } });
  b.active = 'tab1'; b.execute = async action => ({ executed: action }); return b;
}
test('website inputs cannot run scripts, open local files, or embed credentials', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,x', 'https://user:secret@example.com/']) assert.throws(() => webUrl(url));
  assert.equal(webUrl('http://127.0.0.1:4317/'), 'http://127.0.0.1:4317/');
});

test('a page closing itself is removed without breaking live tabs', () => {
  const b=workspace();b.active='dead';
  let removed=0,added=0;
  b.window={contentView:{removeChildView:()=>removed++,addChildView:()=>added++}};
  b.tabs.get('tab1').view.setBounds=()=>{};
  b.tabs.set('dead',{id:'dead',view:{webContents:undefined}});
  const state=b.state();
  assert.deepEqual(state.tabs.map(t=>t.id),['tab1']);
  assert.equal(b.active,'tab1');assert.equal(removed,1);assert.equal(added,1);
  assert.throws(()=>b.tab('dead'),/closed/);
});
test('browser actions reject arbitrary scripts, unknown keys and invalid refs', () => {
  assert.throws(() => validateAction({ action: 'evaluate', script: 'alert(1)' }));
  assert.throws(() => validateAction({ action: 'click', ref: 'button' }));
  assert.throws(() => validateAction({ action: 'press', key: 'Control+L' }));
});

test('file upload requires a local file and always queues explicit approval', async () => {
  const b = workspace();
  assert.throws(() => validateAction({action:'upload',ref:'r1234abcd-1',path:'relative.pdf'}));
  const queued = b.request({action:'upload',ref:'r1234abcd-1',path:__filename},'test-app',true);
  assert.ok(queued.approvalId);
  await b.decide(queued.approvalId,false);
  await assert.rejects(queued.promise,/declined/);
});

test('saved task permission permits upload without a pending approval', async () => {
  const b=workspace();
  const request=b.request({action:'upload',ref:'r1234abcd-1',path:__filename},'opportunity-radar-jobs',true,true);
  assert.equal(request.approvalId,undefined);
  assert.equal((await request.promise).executed.action,'upload');
});
test('local apps queue mutations; approval is required before execution', async () => {
  const b = workspace(), pending = b.request({ action: 'fill', ref: 'r1234abcd-1', text: 'Draft message' }, 'Local app');
  assert.ok(pending.approvalId); assert.equal(b.pending.size, 1);
  await b.decide(pending.approvalId, true);
  const result = await pending.promise; assert.equal(result.executed.tabId, 'tab1'); assert.equal(b.approvalResult(pending.approvalId).state, 'complete');
});
test('approval cannot follow the user to a different URL', async () => {
  const b = workspace(), pending = b.request({ action: 'click', ref: 'r1234abcd-1' });
  b.tabs.get('tab1').view.webContents.getURL = () => 'https://other.example/';
  await b.decide(pending.approvalId, true);
  await assert.rejects(pending.promise, /page changed/);
});
test('declining and stopping reject queued actions without executing them', async () => {
  const b = workspace(); let calls = 0; b.execute = async () => { calls++; };
  const pending = b.request({ action: 'press', key: 'Enter' }, 'AI assistant');
  b.cancelPending('AI assistant'); await assert.rejects(pending.promise, /declined/); assert.equal(calls, 0);
});
test('per-task authorization does not persist as a browser permission', async () => {
  const b = workspace(); const action = { action: 'press', key: 'Enter' };
  assert.equal(b.request(action, 'AI assistant', true).approvalId, undefined);
  const next = b.request(action, 'Local app'); assert.ok(next.approvalId); await b.decide(next.approvalId, false);
});
