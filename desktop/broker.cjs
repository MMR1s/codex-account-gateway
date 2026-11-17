'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { validateAction } = require('./policy.cjs');

// The integration boundary for apps and agents. Results and event records live
// only in memory; page text and typed content are never placed in event records.
class BrowserBroker {
  constructor(browser, permissions = null) { this.browser = browser; this.permissions=permissions; this.requests = new Map(); this.events = []; this.sequence = 0; }
  event(record) {
    this.events.push({ sequence: ++this.sequence, at: new Date().toISOString(), requestId: record.requestId, clientId: record.clientId, action: record.action.action, tabId: record.action.tabId || null, state: record.state });
    if (this.events.length > 500) this.events.shift();
  }
  public(record) { return { requestId: record.requestId, clientId: record.clientId, state: record.state, approvalId: record.approvalId || null, result: record.result ?? null, error: record.error || null, updatedAt: record.updatedAt }; }
  async submit(input, authorized = false) {
    const wrapped = input && typeof input.action === 'object';
    const action = validateAction(wrapped ? input.action : input);
    const clientId = wrapped ? input.clientId || 'local-app' : 'local-app';
    const requestId = wrapped ? input.requestId || randomUUID() : randomUUID();
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9._:-]{1,80}$/.test(clientId)) throw Error('Use a short clientId containing letters, digits, dots, colons, underscores, or hyphens.');
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(requestId)) throw Error('Use a short stable requestId, such as a UUID.');
    const key = `${clientId}/${requestId}`, hash = createHash('sha256').update(JSON.stringify(action)).digest('hex');
    if (this.requests.has(key)) {
      const old = this.requests.get(key); if (old.hash !== hash) throw Error('This requestId was already used for a different action.');
      return wrapped ? this.public(old) : old.result;
    }
    const record = { requestId, clientId, action, hash, state: 'running', updatedAt: new Date().toISOString() };
    this.requests.set(key, record); this.event(record);
    try {
      const persistent = this.permissions?.allows(clientId,action) === true;
      const request = this.browser.request(action, clientId, authorized || persistent, persistent);
      record.promise = request.promise;
      if (request.approvalId) {
        record.state = 'awaiting-approval'; record.approvalId = request.approvalId; this.event(record);
        request.promise.then(result => this.finish(record, result), error => this.finish(record, null, error));
        return wrapped ? this.public(record) : { pendingApproval: true, approvalId: request.approvalId, requestId, clientId };
      }
      const result = await request.promise; this.finish(record, result);
      return wrapped ? this.public(record) : result;
    } catch (error) { this.finish(record, null, error); throw error; }
  }
  finish(record, result, error) {
    record.state = error ? 'error' : 'complete'; record.result = result; record.error = error?.message; record.updatedAt = new Date().toISOString(); this.event(record);
    // Never evict an in-flight request, because a retry could execute it twice.
    while (this.requests.size > 200) {
      const old = [...this.requests.entries()].find(([, r]) => ['complete','error'].includes(r.state));
      if (!old) break; this.requests.delete(old[0]);
    }
  }
  get(clientId, requestId) { const record = this.requests.get(`${clientId}/${requestId}`); return record ? this.public(record) : { state: 'unknown', clientId, requestId }; }
  wait(clientId, requestId) { const record = this.requests.get(`${clientId}/${requestId}`); if (!record) return Promise.reject(Error('Browser request is no longer retained.')); return record.promise; }
  since(sequence = 0) { return { nextSequence: this.sequence, oldestSequence: this.events[0]?.sequence || 0, events: this.events.filter(e => e.sequence > sequence) }; }
}
module.exports = { BrowserBroker };
