const test = require('node:test');
const assert = require('node:assert/strict');
const { BrowserBroker } = require('../broker.cjs');
test('retries with one client/request ID do not repeat browser actions', async () => {
  let calls = 0;
  const broker = new BrowserBroker({ request: () => ({ promise: Promise.resolve({ count: ++calls }) }) });
  const request = { clientId: 'app1', requestId: 'task1', action: { action: 'snapshot' } };
  assert.equal((await broker.submit(request)).result.count, 1);
  assert.equal((await broker.submit(request)).result.count, 1);
  assert.equal(calls, 1);
  await assert.rejects(broker.submit({ ...request, action: { action: 'tabs' } }), /different action/);
});
test('agents can track approvals and completion without leaking page text in events', async () => {
  let resolve;
  const broker = new BrowserBroker({ request: () => ({ approvalId: 'approval1', promise: new Promise(r => { resolve = r; }) }) });
  const input = { clientId: 'agent1', requestId: 'send1', action: { action: 'fill', ref: 'r1234abcd-1', text: 'Private draft text' } };
  assert.equal((await broker.submit(input)).state, 'awaiting-approval');
  resolve({ filled: true }); await new Promise(r => setImmediate(r));
  assert.equal(broker.get('agent1', 'send1').state, 'complete');
  assert.ok(!JSON.stringify(broker.since()).includes('Private draft text'));
  assert.equal(broker.get('other-agent', 'send1').state, 'unknown');
});
