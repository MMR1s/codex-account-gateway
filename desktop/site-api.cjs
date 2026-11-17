'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const SECRET = /password|passcode|secret|token|authorization|cookie|csrf|session|api.?key|transaction.?id/i;
const LOGIN = /\/(?:login|signin|sign-in|oauth|auth|token|password|logout|sessions?)(?:\/|$)/i;
const MUTATING = /(?:^|\/)(?:send|delete|remove|create|update|publish|follow|unfollow|like|unlike|purchase|checkout|logout)(?:\/|$)/i;
const KEEP_HEADERS = new Set(['accept','content-type','x-requested-with']);
const MAX_BODY = 256 * 1024;
function hasSecret(value,depth=0){if(depth>10)return true;if(Array.isArray(value))return value.some(v=>hasSecret(v,depth+1));if(value&&typeof value==='object')return Object.entries(value).some(([k,v])=>SECRET.test(k)||hasSecret(v,depth+1));if(typeof value==='string'){const parsed=json(value);return parsed&&typeof parsed==='object'?hasSecret(parsed,depth+1):false;}return false;}
function scrub(value, depth = 0) {
  if (depth > 12) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 100).map(v => scrub(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 200).map(([k,v]) => [k, SECRET.test(k) ? '[redacted]' : scrub(v, depth + 1)]));
  if(typeof value==='string'){const parsed=json(value);return parsed&&typeof parsed==='object'?JSON.stringify(scrub(parsed,depth+1)):value.slice(0,16000);}return value;
}
function cleanUrl(value) { const u = new URL(value); for (const key of u.searchParams.keys()) if (SECRET.test(key)||hasSecret(u.searchParams.get(key))) u.searchParams.set(key, '[session]'); u.hash=''; return u.href; }
function json(text) { try { return JSON.parse(text); } catch { return undefined; } }
function bodyPaths(value, prefix = '', depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return [];
  return Object.entries(value).flatMap(([key,v]) => SECRET.test(key) ? [] : v && typeof v === 'object' && !Array.isArray(v) ? bodyPaths(v, prefix + key + '.', depth + 1) : [prefix + key]).slice(0, 30);
}
function parts(value) {
  if (typeof value !== 'string' || !/^[\w-]+(?:\.[\w-]+)*$/.test(value)) throw Error('Use a simple dotted JSON field path.');
  const result = value.split('.'); if (result.some(p => ['__proto__','constructor','prototype'].includes(p) || SECRET.test(p))) throw Error('Session and credential fields cannot become operation parameters.'); return result;
}
function get(object, key) { return parts(key).reduce((v,k) => v?.[k], object); }
function set(object, key, value) { const keys = parts(key); let target = object; for (const k of keys.slice(0,-1)) { if (!target[k] || typeof target[k] !== 'object') throw Error('The recorded JSON path changed.'); target = target[k]; } target[keys.at(-1)] = value; }
function sanitizeBody(value, refs, vault, prefix = '') {
  if (Array.isArray(value)) return value.map((v,i) => sanitizeBody(v,refs,vault,prefix ? `${prefix}.${i}` : String(i)));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key,v]) => {
    const p = prefix ? `${prefix}.${key}` : key;
    if (SECRET.test(key)||typeof v==='string'&&hasSecret(v)) { refs.push(p); vault[p] = v; return [key, '[session]']; }
    return [key, sanitizeBody(v,refs,vault,p)];
  }));
}

class SiteApi {
  constructor({ browser, stateDir, emit }) {
    this.browser = browser; this.emit = emit; this.captures = new Map(); this.vault = new Map();
    this.file = path.join(stateDir, 'site-api-operations.json');
    process.env.API_ANYTHING_LOCAL_ONLY = '1';
    process.env.API_ANYTHING_HOME = path.join(stateDir, 'api-anything');
    try { this.operations = JSON.parse(fs.readFileSync(this.file,'utf8')).operations || []; } catch (e) { if (e.code !== 'ENOENT') throw e; this.operations=[]; }
  }
  async sdk() { this.library ||= Promise.all([import('api-anything'), import('api-anything/host')]); return this.library; }
  save() { const temp = this.file + '.tmp'; fs.writeFileSync(temp, JSON.stringify({ version: 1, operations: this.operations }, null, 2), { mode: 0o600 }); fs.renameSync(temp,this.file); }
  summary(op) { return { id:op.id,name:op.name,origin:op.origin,method:op.method,url:op.url,readOnly:op.readOnly,params:op.params,requiresRecapture:op.sessionRefs.length>0&&!this.vault.has(op.id),learnedAt:op.learnedAt,compiler:'api-anything@0.4.0',warnings:op.warnings }; }
  state() { return { engine:'api-anything@0.4.0',localOnly:true,operations:this.operations.map(op=>this.summary(op)),captures:[...this.captures].map(([tabId,c])=>({tabId,active:c.active,requests:c.records.length})) }; }
  publish() { this.emit('site-api', this.state()); }
  isWrite(id) { const op=this.operations.find(o=>o.id===id); if(!op) throw Error('Saved operation not found.'); return !op.readOnly; }
  async start(tabId) {
    const tab=this.browser.tab(tabId),wc=tab.view.webContents,u=new URL(wc.getURL());
    if(!['http:','https:'].includes(u.protocol)) throw Error('Open a website first.');
    const existing=this.captures.get(tab.id); if(existing) { existing.active=false; wc.debugger.removeListener('message',existing.listener); }
    if(!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    const capture={active:true,origin:u.origin,pending:new Map(),records:[],bytes:0};
    capture.listener=(_event,method,p)=>{ this.observe(tab,capture,method,p).catch(()=>{}); };
    this.captures.set(tab.id,capture); wc.debugger.on('message',capture.listener);
    await wc.debugger.sendCommand('Network.enable'); this.publish();
    return {tabId:tab.id,capturing:true,origin:u.origin,notice:'Recording same-origin JSON Fetch/XHR requests in this tab. Use the website once, then list captured requests. Cookies and auth values are never returned.'};
  }
  async observe(tab,c,method,p) {
    if(!c.active || c.records.length>=60 || c.bytes>8*1024*1024) return;
    if(method==='Network.requestWillBeSent') {
      const r=p.request; let u; try{u=new URL(r.url);}catch{return;}
      if(u.origin!==c.origin || LOGIN.test(u.pathname) || !['Fetch','XHR'].includes(p.type)) return;
      if(c.pending.size>=100)c.pending.delete(c.pending.keys().next().value);
      c.pending.set(p.requestId,{resourceType:p.type.toLowerCase(),request:{method:r.method,url:r.url,headers:Object.fromEntries(Object.entries(r.headers||{}).map(([k,v])=>[k.toLowerCase(),String(v)])),...(r.postData?{body:r.postData.slice(0,MAX_BODY)}:{})}});
    } else if(method==='Network.responseReceived') {
      const item=c.pending.get(p.requestId); if(!item)return;
      if(!/json/i.test(p.response.mimeType||'') || p.response.status<200 || p.response.status>=300) { c.pending.delete(p.requestId);return; }
      item.response={status:p.response.status,headers:{'content-type':p.response.mimeType},contentType:p.response.mimeType};
    } else if(method==='Network.loadingFinished') {
      const item=c.pending.get(p.requestId); c.pending.delete(p.requestId); if(!item?.response || p.encodedDataLength>MAX_BODY)return;
      const value=await tab.view.webContents.debugger.sendCommand('Network.getResponseBody',{requestId:p.requestId});
      const text=value.base64Encoded?Buffer.from(value.body,'base64').toString('utf8'):value.body;
      if(text.length>MAX_BODY || json(text)===undefined || !c.active)return;
      item.response.body=text; item.id=c.records.length+1; item.captureId=randomUUID(); c.records.push(item);c.bytes+=text.length;this.publish();
    } else if(method==='Network.loadingFailed')c.pending.delete(p.requestId);
  }
  stop(tabId) { const tab=this.browser.tab(tabId),c=this.captures.get(tab.id); if(c){c.active=false;c.pending.clear();} this.publish(); return this.list(tab.id); }
  list(tabId) {
    const tab=this.browser.tab(tabId),c=this.captures.get(tab.id);
    return {tabId:tab.id,capturing:!!c?.active,requests:(c?.records||[]).map(r=>({id:r.captureId,method:r.request.method,url:cleanUrl(r.request.url),status:r.response.status,queryParams:[...new URL(r.request.url).searchParams.keys()].filter(k=>!SECRET.test(k)),bodyParams:bodyPaths(json(r.request.body||'')),responsePreview:JSON.stringify(scrub(json(r.response.body))).slice(0,1800)}))};
  }
  async learn(a) {
    const tab=this.browser.tab(a.tabId),c=this.captures.get(tab.id),record=c?.records.find(r=>r.captureId===a.captureId);
    if(!record)throw Error('Captured request not found in this tab. Start recording and use the website once.');
    if(new URL(tab.view.webContents.getURL()).origin!==c.origin)throw Error('Return to the website where this request was captured.');
    const url=new URL(record.request.url),body=json(record.request.body||''),params=[],examples={};
    for(const key of a.queryParams||[]) { if(SECRET.test(key)||!url.searchParams.has(key)||hasSecret(url.searchParams.get(key)))throw Error('Choose an observed, non-credential query parameter.');const name='query_'+key.replace(/[^\w]/g,'_');if(params.some(p=>p.name===name))throw Error('Parameter names collide.');params.push({name,location:'query',key});examples[name]=url.searchParams.get(key); }
    for(const key of a.bodyParams||[]) { const value=get(body,key);if(value===undefined)throw Error('Choose an observed JSON body field.');if(hasSecret(value))throw Error('Credential-containing objects cannot become parameters.');const name='body_'+key.replace(/[^\w]/g,'_');if(params.some(p=>p.name===name))throw Error('Parameter names collide.');params.push({name,location:'body',key});examples[name]=value; }
    const [api]=await this.sdk();
    const learned=api.learnOperation({exchanges:[{...record,id:1}],examples:[examples],cookies:[],id:1,name:a.name,trigger:{url:c.origin+'/'},readOnly:a.readOnly});
    const safeHeaders={},sessionRefs=[],vault={headers:{},query:{},body:{}};
    for(const [key,value]of Object.entries(record.request.headers)) {
      if(SECRET.test(key)&&key!=='cookie'){safeHeaders[key]='[session]';vault.headers[key]=value;sessionRefs.push('header:'+key);}
      else if(KEEP_HEADERS.has(key))safeHeaders[key]=value;
    }
    for(const key of url.searchParams.keys())if(SECRET.test(key)||hasSecret(url.searchParams.get(key))){vault.query[key]=url.searchParams.get(key);url.searchParams.set(key,'[session]');sessionRefs.push('query:'+key);}
    const bodyRefs=[];let safeBody=body===undefined?undefined:sanitizeBody(body,bodyRefs,vault.body);
    for(const key of bodyRefs)sessionRefs.push('body:'+key);
    if(record.request.body&&body===undefined)throw Error('Only GET/HEAD or JSON request bodies are supported in this first version.');
    if(['GET','HEAD'].includes(record.request.method)===false&&safeBody===undefined)throw Error('This request has no supported JSON body.');
    if(a.readOnly&&(MUTATING.test(url.pathname)||['PUT','PATCH','DELETE'].includes(record.request.method)||/^\s*mutation\b/i.test(body?.query||'')||/^(?:send|delete|remove|create|update|publish|purchase|follow|unfollow|like)/i.test(body?.operationName||'')))throw Error('This endpoint looks like a write. Save it as a write operation.');
    for(const p of params){if(p.location==='query')url.searchParams.set(p.key,'{'+p.name+'}');else set(safeBody,p.key,'{'+p.name+'}');}
    // Store only the compiler's response recipe and warnings; raw credentials and
    // captured examples stay in memory, never in saved manifests or catalogs.
    const op={id:randomUUID(),name:a.name,origin:c.origin,method:record.request.method,url:url.href,headers:safeHeaders,...(safeBody!==undefined?{body:safeBody}:{}),params,sessionRefs,readOnly:a.readOnly,responseRecipe:learned.operation.response,warnings:learned.warnings,learnedAt:new Date().toISOString()};
    if(this.operations.some(o=>o.name===op.name&&o.origin===op.origin))throw Error('That operation name already exists for this website. Choose another name.');
    this.operations.push(op);this.vault.set(op.id,vault);this.save();this.publish();return this.summary(op);
  }
  materialize(id,args={}) {
    const op=this.operations.find(o=>o.id===id);if(!op)throw Error('Saved operation not found.');
    const vault=this.vault.get(id);if(op.sessionRefs.length&&!vault)throw Error('This operation needs fresh session headers. Recapture and save a new operation after signing in.');
    const extra=Object.keys(args).filter(k=>!op.params.some(p=>p.name===k));if(extra.length)throw Error('Unknown parameters: '+extra.join(', '));
    const url=new URL(op.url),body=op.body===undefined?undefined:structuredClone(op.body),headers={...op.headers};
    for(const p of op.params){if(args[p.name]===undefined)throw Error('Missing parameter: '+p.name);if(p.location==='query')url.searchParams.set(p.key,typeof args[p.name]==='string'?args[p.name]:JSON.stringify(args[p.name]));else set(body,p.key,args[p.name]);}
    for(const key of Object.keys(vault?.headers||{}))headers[key]=vault.headers[key];
    for(const key of Object.keys(vault?.query||{}))url.searchParams.set(key,vault.query[key]);
    for(const [key,value]of Object.entries(vault?.body||{})){
      const keys=key.split('.');let target=body;for(const k of keys.slice(0,-1))target=target[k];target[keys.at(-1)]=value;
    }
    return {op,url:url.href,method:op.method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})};
  }
  plan(a) { const {op,url,method,body}=this.materialize(a.operationId,a.args);return {operation:this.summary(op),request:{method,url:cleanUrl(url),...(body?{body:scrub(json(body))}:{})},approvalRequired:!op.readOnly,transport:'existing signed-in browser; same-origin fetch',writeVerification:op.readOnly?'not-applicable':'A successful response alone does not prove delivery; verify through a subsequent read.'}; }
  async call(a) {
    const tab=this.browser.tab(a.tabId),request=this.materialize(a.operationId,a.args);
    if(new URL(tab.view.webContents.getURL()).origin!==request.op.origin)throw Error('Open a tab on '+request.op.origin+' before calling this operation.');
    const c=this.captures.get(tab.id),wasActive=c?.active;if(c)c.active=false;
    try {
      const result=await tab.view.webContents.executeJavaScript(`(async()=>{const r=${JSON.stringify({url:request.url,method:request.method,headers:request.headers,body:request.body})};const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);try{const response=await fetch(r.url,{method:r.method,headers:r.headers,...(r.body!==undefined?{body:r.body}:{}),credentials:'include',mode:'same-origin',redirect:'error',signal:controller.signal});const reader=response.body?.getReader();let text='',bytes=0;const decoder=new TextDecoder();if(reader){for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>${MAX_BODY}){await reader.cancel();return{status:response.status,error:'Response exceeds 256 KiB; narrow the query.'};}text+=decoder.decode(part.value,{stream:true});}}return{status:response.status,ok:response.ok,text};}catch{return{error:'Request failed or its outcome is unknown. No automatic retry was performed.'};}finally{clearTimeout(timer);}})()`);
      return {operationId:request.op.id,transport:'browser-api',...(result.status?{status:result.status}:{}),ok:!!result.ok,...(result.error?{error:result.error}:{}),data:result.text?scrub(json(result.text)??result.text.slice(0,16000)):null,...(!request.op.readOnly?{write:result.error?'unknown':'sent-unverified',verification:'Read the website or a read operation to confirm the intended change before claiming success.'}:{})};
    } finally {if(c)c.active=wasActive;}
  }
  async catalog(a) {
    const [,host]=await this.sdk();
    if(a.action==='catalog_sites'){const sites=host.hostSites().filter(s=>!a.query||`${s.name} ${s.hosts.join(' ')}`.toLowerCase().includes(a.query.toLowerCase()));const offset=a.offset||0,limit=a.limit||20;return {localOnly:true,total:sites.length,nextOffset:offset+limit<sites.length?offset+limit:null,sites:sites.slice(offset,offset+limit).map(s=>({name:s.name,hosts:s.hosts,operations:s.operations.filter(o=>o.readOnly).map(o=>({name:o.name,description:o.description}))}))};}
    if(a.action==='catalog_describe')return host.hostSite(a.site);
    const plan=host.planCall(a.site,a.operation,a.args||{},{maxTier:1});
    if(!plan.ok)return plan;
    if(!plan.readOnly)throw Error('The public catalog integration is read-only. Learn signed-in writes through the gateway browser.');
    if(a.action==='catalog_plan')return {ok:true,site:plan.site,operation:plan.op,readOnly:true,signedIn:plan.signedIn,tier:plan.tier,request:plan.request};
    return host.callPlanned(plan,{maxTier:1,allowWrites:false,timeoutMs:15000,view:{maxChars:20000}});
  }
  async execute(a) {
    if(a.action==='api_capture_start')return this.start(a.tabId);
    if(a.action==='api_capture_stop')return this.stop(a.tabId);
    if(a.action==='api_requests')return this.list(a.tabId);
    if(a.action==='api_operations')return this.state();
    if(a.action==='api_learn')return this.learn(a);
    if(a.action==='api_plan')return this.plan(a);
    if(a.action==='api_call')return this.call(a);
    return this.catalog(a);
  }
  closeTab(tabId) {const c=this.captures.get(tabId);if(c)c.active=false;this.captures.delete(tabId);}
  async close() {for(const c of this.captures.values())c.active=false;if(this.library){const[,host]=await this.library;await host.closeHost();}}
}
module.exports={SiteApi,scrub,cleanUrl,bodyPaths,SECRET};
