// Opt-in native integration: uses only a local fake service for capture/writes.
const path=require('node:path'),fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
const stateDir=path.resolve(__dirname,`../../.runtime/api-smoke-${process.pid}`);process.env.CODEX_BROWSER_STATE_DIR=stateDir;
const {app,BrowserWindow}=require('electron');require('../main.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=30000){const start=Date.now();while(Date.now()-start<ms){const value=await fn();if(value)return value;await sleep(200);}throw Error('API integration timed out.');}
let server;
(async()=>{
  await app.whenReady();const win=await until(()=>BrowserWindow.getAllWindows()[0]);await until(()=>fs.existsSync(path.join(stateDir,'browser-session.json')));
  const connection=JSON.parse(fs.readFileSync(path.join(stateDir,'browser-session.json')));let writes=0,reads=0;
  const fixture=`<!doctype html><html><head><title>API Learning Fixture</title></head><body><h1>Shared browser API fixture</h1><p id="loaded">Loading…</p><button id="send" onclick="fetch('/api/send',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':'fixture-private-csrf'},body:JSON.stringify({message:'first-local-message'})}).then(r=>r.json()).then(x=>document.querySelector('#loaded').textContent='Local write '+x.count)">Send to local fixture</button><script>fetch('/api/search?q=alpha',{headers:{'x-csrf-token':'fixture-private-csrf'}}).then(r=>r.json()).then(x=>document.querySelector('#loaded').textContent=x.items[0].title);</script></body></html>`;
  server=http.createServer(async(req,res)=>{
    if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html','Set-Cookie':'fixture_session=fixture-private-session; HttpOnly; SameSite=Lax; Path=/'});res.end(fixture);return;}
    if(req.url.startsWith('/api/')){
      if(!req.headers.cookie?.includes('fixture_session=fixture-private-session')||req.headers['x-csrf-token']!=='fixture-private-csrf'){res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"auth-required"}');return;}
      res.setHeader('Content-Type','application/json');
      if(req.url.startsWith('/api/search')){reads++;const q=new URL(req.url,'http://fixture').searchParams.get('q');res.end(JSON.stringify({items:[{id:1,title:q},{id:2,title:'other'}],access_token:'fixture-response-secret'}));return;}
      if(req.url==='/api/send'){let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);writes++;res.end(JSON.stringify({id:writes,count:writes,message:body.message}));return;}
    }
    res.writeHead(404);res.end();
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let sequence=0;
  async function call(action,id){const response=await fetch(`http://127.0.0.1:${connection.port}/control`,{method:'POST',headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'},body:JSON.stringify({clientId:'api-smoke',requestId:id||'req-'+(++sequence),action})});const out=await response.json();if(!response.ok)throw Error(out.error);return out;}
  async function approve(record){assert.equal(record.state,'awaiting-approval');await win.webContents.executeJavaScript(`window.relay.approve(${JSON.stringify(record.approvalId)},true)`);return until(async()=>{const r=await fetch(`http://127.0.0.1:${connection.port}/requests/${record.requestId}?clientId=api-smoke`,{headers:{Authorization:`Bearer ${connection.token}`}});const out=await r.json();if(out.state==='error')throw Error(out.error);return out.state==='complete'?out:false;});}
  const opened=await call({action:'open',url:`http://127.0.0.1:${server.address().port}/`});const tabId=opened.result.tabId;
  await until(async()=> (await call({action:'snapshot',tabId})).result.title==='API Learning Fixture');
  await call({action:'api_capture_start',tabId});await call({action:'reload',tabId});
  const search=await until(async()=>{const r=await call({action:'api_requests',tabId});return r.result.requests.find(x=>x.url.includes('/api/search'));});
  assert.ok(!JSON.stringify(search).includes('fixture-private-csrf'));assert.ok(!JSON.stringify(search).includes('fixture-response-secret'));
  const readOp=(await approve(await call({action:'api_learn',tabId,captureId:search.id,name:'search-fixture',readOnly:true,queryParams:['q']}))).result;
  const read=await call({action:'api_call',tabId,operationId:readOp.id,args:{query_q:'gamma'}});assert.equal(read.state,'complete');assert.equal(read.result.data.items[0].title,'gamma');assert.equal(read.result.data.access_token,'[redacted]');
  console.log('PASS: native capture → API Anything learning → authenticated parameterized read without UI clicks.');
  let snap=(await call({action:'snapshot',tabId})).result;
  const button=snap.elements.find(e=>e.tag==='button');await approve(await call({action:'click',tabId,ref:button.ref}));
  const send=await until(async()=>{const r=await call({action:'api_requests',tabId});return r.result.requests.find(x=>x.url.endsWith('/api/send'));});
  const writeOp=(await approve(await call({action:'api_learn',tabId,captureId:send.id,name:'send-fixture',readOnly:false,bodyParams:['message']}))).result;
  const before=writes;const pending=await call({action:'api_call',tabId,operationId:writeOp.id,args:{body_message:'second-local-message'}},'write-once');assert.equal(writes,before);const written=await approve(pending);assert.equal(writes,before+1);assert.equal(written.result.write,'sent-unverified');
  await call({action:'api_call',tabId,operationId:writeOp.id,args:{body_message:'second-local-message'}},'write-once');assert.equal(writes,before+1);
  const manifest=fs.readFileSync(path.join(stateDir,'site-api-operations.json'),'utf8');assert.ok(!manifest.includes('fixture-private-csrf'));assert.ok(!manifest.includes('fixture-private-session'));
  console.log('PASS: writes need approval, are sent once, are not mislabeled delivered, and retry IDs deduplicate.');
  await call({action:'api_capture_stop',tabId});
  const catalog=await call({action:'catalog_sites',query:'wikipedia',limit:2});assert.ok(catalog.result.sites.some(s=>s.name==='wikipedia'));console.log('PASS: API Anything host catalog integrated locally.');
  await win.webContents.executeJavaScript('window.relay.connect()');
  const prompt='Use api_operations to find search-fixture, then use api_call on my current tab with query_q set to delta. Tell me the first returned title. Use the reusable API only; do not click, navigate, type into the website, or call a write operation.';
  await win.webContents.executeJavaScript(`(()=>{document.getElementById('prompt').value=${JSON.stringify(prompt)};document.getElementById('chat-form').requestSubmit();})()`);
  const state=await until(async()=>{const s=await win.webContents.executeJavaScript('window.relay.state()');const error=s.events.find(e=>e.data.kind==='error');if(error)throw Error(error.data.message);const done=s.events.find(e=>e.data.kind==='complete');if(!done)return false;if(done.data.error)throw Error(done.data.error);return s;},180000);
  const tools=state.events.filter(e=>e.data.kind==='tool'&&e.data.state==='complete').map(e=>e.data.action);assert.ok(tools.includes('api_call'));assert.ok(!tools.some(a=>['click','fill','press'].includes(a)));
  const answer=state.events.filter(e=>e.data.kind==='message').map(e=>e.data.text).join('\n');assert.match(answer,/delta/i);
  console.log('PASS: live Codex reused the learned API with no UI actions.');
  const result={passed:true,engine:'api-anything@0.4.0',readCalls:reads,localWrites:writes,tools,answer,provider:state.events.find(e=>e.data.kind==='thread')?.data.provider};
  fs.mkdirSync(path.join(__dirname,'../artifacts'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../artifacts/api-smoke-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));server.close();app.quit();
})().catch(error=>{console.error('FAIL:',error.stack);server?.close();app.exit(1);});
