'use strict';
const ACTIONS = ['tabs', 'open', 'select', 'close', 'navigate', 'back', 'forward', 'reload', 'snapshot', 'screenshot', 'click', 'fill', 'press', 'scroll', 'api_capture_start', 'api_capture_stop', 'api_requests', 'api_operations', 'api_learn', 'api_plan', 'api_call', 'catalog_sites', 'catalog_describe', 'catalog_plan', 'catalog_call'];
ACTIONS.push('form_snapshot', 'upload');
const MUTATIONS = new Set(['click', 'fill', 'press', 'upload']);
function webUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error('Use an HTTP or HTTPS address without embedded credentials.');
  return url.href;
}
function validateAction(input) {
  if (!input || typeof input !== 'object' || !ACTIONS.includes(input.action)) throw Error('Unknown browser action.');
  const a = { action: input.action };
  if (input.tabId !== undefined) { if (typeof input.tabId !== 'string' || input.tabId.length > 80) throw Error('Invalid tab ID.'); a.tabId = input.tabId; }
  if (['open', 'navigate'].includes(a.action)) a.url = webUrl(input.url);
  if (['click', 'fill', 'upload'].includes(a.action)) {
    if (typeof input.ref !== 'string' || !/^r[0-9a-f]{8}-\d+$/.test(input.ref)) throw Error('Use an element reference from a fresh browser snapshot.');
    a.ref = input.ref;
  }
  if (a.action === 'fill') { if (typeof input.text !== 'string' || input.text.length > 20000) throw Error('Text must be under 20,000 characters.'); a.text = input.text; }
  if (a.action === 'upload') {
    const path = require('node:path'), fs = require('node:fs');
    if (typeof input.path !== 'string' || !path.isAbsolute(input.path) || input.path.startsWith('\\\\')) throw Error('Choose an absolute local file path.');
    const resolved = fs.realpathSync(input.path), stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw Error('Choose a file under 20 MB.');
    a.path = resolved;
  }
  if (a.action === 'press') {
    if (!['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Control+A', 'Meta+A', 'Space'].includes(input.key)) throw Error('Unsupported key.');
    a.key = input.key;
  }
  if (a.action === 'scroll') {
    a.direction = input.direction || 'down';
    if (!['up', 'down'].includes(a.direction)) throw Error('Scroll direction must be up or down.');
    a.amount = Math.max(100, Math.min(2500, Number(input.amount) || 650));
  }
  if(a.action==='api_learn') {
    if(typeof input.captureId!=='string'||!/^[0-9a-f-]{36}$/.test(input.captureId))throw Error('Choose a captured request ID.');
    if(typeof input.name!=='string'||!/^[a-z][a-z0-9_-]{1,63}$/.test(input.name))throw Error('Use a lowercase operation name, 2–64 characters.');
    if(typeof input.readOnly!=='boolean')throw Error('Specify whether this operation is a read or a write.');
    Object.assign(a,{captureId:input.captureId,name:input.name,readOnly:input.readOnly});
    for(const field of ['queryParams','bodyParams']) { const values=input[field]||[];if(!Array.isArray(values)||values.length>20||values.some(v=>typeof v!=='string'||v.length>100))throw Error('Choose up to 20 observed parameter names.');a[field]=values; }
  }
  if(['api_plan','api_call'].includes(a.action)) {
    if(typeof input.operationId!=='string'||!/^[0-9a-f-]{36}$/.test(input.operationId))throw Error('Choose a saved operation ID.');a.operationId=input.operationId;
  }
  if(['catalog_describe','catalog_plan','catalog_call'].includes(a.action)) {
    if(typeof input.site!=='string'||!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(input.site))throw Error('Choose an installed catalog site.');a.site=input.site;
  }
  if(['catalog_plan','catalog_call'].includes(a.action)) {
    if(typeof input.operation!=='string'||!/^[a-zA-Z0-9._-]{1,100}$/.test(input.operation))throw Error('Choose a catalog operation.');a.operation=input.operation;
  }
  if(['api_plan','api_call','catalog_plan','catalog_call'].includes(a.action)) {
    const args=input.args||{};if(!args||typeof args!=='object'||Array.isArray(args)||JSON.stringify(args).length>20000)throw Error('Arguments must be a JSON object under 20 KB.');a.args=structuredClone(args);
  }
  if(a.action==='catalog_sites') { a.query=String(input.query||'').slice(0,100);a.offset=Math.max(0,Math.min(10000,Number(input.offset)||0));a.limit=Math.max(1,Math.min(30,Number(input.limit)||20)); }
  return a;
}
module.exports = { ACTIONS, MUTATIONS, webUrl, validateAction };
