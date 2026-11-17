const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {SiteApi,scrub,cleanUrl}=require('../site-api.cjs');
const {BrowserWorkspace}=require('../browser.cjs');
function setup(){
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-api-unit-'));
  const wc={getURL:()=> 'https://demo.example/',getTitle:()=> 'Demo',isLoading:()=>false};
  const browser={tab:()=>({id:'tab1',view:{webContents:wc}})};
  const api=new SiteApi({browser,stateDir,emit:()=>{}});
  return {api,stateDir,wc,browser};
}
function capture(api,method='GET'){
  const r={id:1,captureId:'12345678-1234-1234-1234-123456789abc',resourceType:'fetch',request:{method,url:method==='GET'?'https://demo.example/api/search?q=alpha':'https://demo.example/api/send',headers:{'x-csrf-token':'private-test-csrf','content-type':'application/json'},...(method==='POST'?{body:JSON.stringify({message:'first message',csrfToken:'private-test-csrf'})}:{})},response:{status:200,headers:{'content-type':'application/json'},contentType:'application/json',body:JSON.stringify({items:[{id:1,title:'alpha'},{id:2,title:'beta'}]})}};
  api.captures.set('tab1',{origin:'https://demo.example',active:false,records:[r]});return r;
}
test('learning uses API Anything, parameterizes a read, and persists no auth value',async()=>{
  const {api,stateDir}=setup();const record=capture(api);
  const op=await api.learn({tabId:'tab1',captureId:record.captureId,name:'search-posts',readOnly:true,queryParams:['q']});
  assert.equal(op.compiler,'api-anything@0.4.0');assert.equal(op.params[0].name,'query_q');
  const request=api.materialize(op.id,{query_q:'changed query'});assert.equal(new URL(request.url).searchParams.get('q'),'changed query');assert.equal(request.headers['x-csrf-token'],'private-test-csrf');
  const saved=fs.readFileSync(path.join(stateDir,'site-api-operations.json'),'utf8');assert.ok(!saved.includes('private-test-csrf'));assert.ok(!JSON.stringify(api.plan({operationId:op.id,args:{query_q:'alpha'}})).includes('private-test-csrf'));
  const restarted=new SiteApi({browser:api.browser,stateDir,emit:()=>{}});assert.throws(()=>restarted.materialize(op.id,{query_q:'x'}),/fresh session/);
});
test('credential parameters and mislabeled writes cannot be learned as public reads',async()=>{
  const {api}=setup();const r=capture(api,'POST');
  await assert.rejects(api.learn({tabId:'tab1',captureId:r.captureId,name:'send-test',readOnly:false,bodyParams:['csrfToken']}),/credential/);
  await assert.rejects(api.learn({tabId:'tab1',captureId:r.captureId,name:'send-test',readOnly:true,bodyParams:['message']}),/write/);
});
test('write calls queue for approval; read calls do not; learning always queues',async()=>{
  const b=new BrowserWorkspace({window:{},View:null,browserSession:null,emit:()=>{}});
  b.tabs.set('tab1',{id:'tab1',view:{webContents:{getURL:()=> 'https://demo.example/',getTitle:()=> 'Demo',isLoading:()=>false}}});b.active='tab1';
  b.api={isWrite:()=>true,plan:()=>({request:{method:'POST',url:'https://demo.example/api/send',body:{message:'draft'}}}),list:()=>({requests:[]})};b.execute=async()=>({ok:true});
  const p=b.request({action:'api_call',operationId:'12345678-1234-1234-1234-123456789abc',args:{}});assert.ok(p.approvalId);await b.decide(p.approvalId,false);await assert.rejects(p.promise);
  b.api.isWrite=()=>false;assert.equal(b.request({action:'api_call',operationId:'12345678-1234-1234-1234-123456789abc',args:{}}).approvalId,undefined);
  const learned=b.request({action:'api_learn',captureId:'12345678-1234-1234-1234-123456789abc',name:'safe-search',readOnly:true},'AI',true);assert.ok(learned.approvalId);await b.decide(learned.approvalId,false);
});
test('capture and response previews redact credential fields recursively',()=>{
  assert.ok(!cleanUrl('https://demo.example/api?access_token=secret&q=hello').includes('=secret'));
  assert.deepEqual(scrub({items:[{text:'visible',auth_token:'secret'}],session:{id:'private'}}),{items:[{text:'visible',auth_token:'[redacted]'}],session:'[redacted]'});
  assert.ok(!cleanUrl('https://demo.example/api?variables='+encodeURIComponent(JSON.stringify({access_token:'nested-secret'}))).includes('nested-secret'));
  assert.ok(!JSON.stringify(scrub({variables:JSON.stringify({password:'nested-secret'})})).includes('nested-secret'));
});
test('catalog discovery is local-only and bounded',async()=>{
  const {api}=setup();const result=await api.catalog({action:'catalog_sites',query:'wikipedia',offset:0,limit:2});
  assert.equal(result.localOnly,true);assert.ok(result.sites.some(s=>s.name==='wikipedia'));assert.ok(result.sites.length<=2);
});
