'use strict';
const $ = id => document.getElementById(id);
let busy = false, connected = false, browserState = null;
const messages = new Map();
const permissionSettings=document.createElement('details');
permissionSettings.className='api-lab';
permissionSettings.innerHTML='<summary>Automatic browser actions</summary><p>Saved on this computer. Actions include clicking, typing, file uploads and sending for tasks you request. Page content cannot authorize a new task.</p><label class="allow"><input id="auto-radar" type="checkbox"> Opportunity Radar outreach</label><label class="allow"><input id="auto-assistant" type="checkbox"> Relay assistant tasks</label><p id="permission-status" role="status"></p>';
$('allow-actions').closest('label').before(permissionSettings);
window.relay.actionPermissions().then(settings=>{ $('auto-radar').checked=settings.radar;$('auto-assistant').checked=settings.assistant; }).catch(e=>status(e.message));
for(const [id,key] of [['auto-radar','radar'],['auto-assistant','assistant']]) $(id).onchange=async()=>{
  const previous=!$(id).checked;
  try {await window.relay.actionPermissions({[key]:$(id).checked});$('permission-status').textContent='Saved. Turn either setting off to require approval again.';}
  catch(e){$(id).checked=previous;$('permission-status').textContent=e.message;}
};
function status(text) { $('agent-status').textContent = text; }
function addMessage(role, text, id) {
  document.querySelector('.welcome')?.remove();
  const existing = id && messages.get(id);
  if (existing) { existing.text.textContent = text; return existing; }
  const box = document.createElement('div'); box.className = `message ${role}`;
  const label = document.createElement('div'); label.className = 'role'; label.textContent = { user: 'YOU', assistant: 'CODEX', error: 'NOTICE', tool: 'BROWSER' }[role];
  const content = document.createElement('div'); content.textContent = text;
  box.append(label, content); $('messages').append(box); const result = { box, text: content }; if (id) messages.set(id, result);
  $('messages').scrollTop = $('messages').scrollHeight; return result;
}
function setBusy(value) { busy = value; $('send').disabled = value; $('stop').hidden = !value; $('new-chat').disabled = value; $('model').disabled = value; $('connect').disabled = value; if (!value) $('allow-actions').checked = false; }
function renderBrowser(data) {
  browserState = data; $('tabs').replaceChildren();
  for (const tab of data.tabs) {
    const node = document.createElement('div'); node.className = `tab${data.activeTabId === tab.id ? ' active' : ''}`; node.setAttribute('role','tab'); node.setAttribute('aria-selected',String(tab.id === data.activeTabId));
    const label = document.createElement('span'); label.textContent = tab.title || 'New tab'; label.title = tab.url;
    const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label', `Close ${tab.title || 'tab'}`); close.onclick = e => { e.stopPropagation(); action({ action: 'close', tabId: tab.id }); };
    node.append(label, close); node.onclick = () => action({ action: 'select', tabId: tab.id }); $('tabs').append(node);
  }
  const active = data.tabs.find(t => t.id === data.activeTabId);
  if (document.activeElement !== $('address')) $('address').value = active?.url || '';
  $('page-status').textContent = active?.loading ? 'Loading…' : `${data.tabs.length} tabs`;
  $('approvals').replaceChildren();
  for (const approval of data.approvals) {
    const card = document.createElement('section'); card.className = 'approval';
    const title = document.createElement('h3'); title.textContent = `${approval.source.startsWith('assistant:') ? 'AI assistant' : approval.source}: ${approval.action.action} needs approval`;
    const preview = document.createElement('p'); preview.textContent = `${approval.url}\n${approval.preview?JSON.stringify(approval.preview,null,2):approval.action.text || approval.action.key || approval.action.ref || ''}`;
    const controls = document.createElement('div');
    for (const [label, approved] of [['Approve action', true], ['Decline', false]]) { const button = document.createElement('button'); button.textContent = label; button.onclick = async () => { try { await window.relay.approve(approval.id, approved); } catch(e) { status(e.message); } }; controls.append(button); }
    card.append(title, preview, controls); $('approvals').append(card);
  }
  layout();
}
async function action(input) { try { return await window.relay.browser(input); } catch (e) { status(e.message); } }
function layout() {
  const rect = $('browser-host').getBoundingClientRect();
  window.relay.bounds({ x: rect.x, y: rect.y, width: browserState?.tabs.length ? rect.width : 0, height: browserState?.tabs.length ? rect.height : 0 }).catch(() => {});
}
function populateModels(models) {
  const selected = $('model').value; $('model').replaceChildren();
  const defaultOption = document.createElement('option'); defaultOption.value = ''; defaultOption.textContent = 'Use configured Codex model'; $('model').append(defaultOption);
  for (const model of models || []) { const option = document.createElement('option'); option.value = model.id; option.textContent = model.name || model.id; $('model').append(option); }
  $('model').value = selected;
}
async function connect() {
  $('connect').disabled = true; status('Connecting to the local Codex runtime…');
  try { const result = await window.relay.connect(); connected = true; populateModels(result.models); $('connect').textContent = 'Connected'; status('Codex ready · uses your configured account/provider.'); }
  catch (e) { status(e.message); $('connect').textContent = 'Retry connection'; }
  finally { $('connect').disabled = false; }
}
window.relay.onEvent(event => {
  if(event.type==='site-api') { $('api-count').textContent=`${event.data.operations.length} saved · ${event.data.captures.reduce((n,c)=>n+c.requests,0)} captured`; return; }
  if (event.type === 'browser') return renderBrowser(event.data);
  if (event.type === 'notice') return status(event.data);
  if (event.type !== 'agent') return;
  const data = event.data;
  if (data.kind === 'ready') { connected = true; populateModels(data.models); $('connect').textContent = 'Connected'; status('Codex ready · uses your configured account/provider.'); }
  if (data.kind === 'thread') status(`${data.model} · ${data.provider} · browser tools connected`);
  if (data.kind === 'retry') status(data.message);
  if (data.kind === 'delta') { const current = messages.get(data.itemId)?.text.textContent || ''; addMessage('assistant', current + data.text, data.itemId); }
  if (data.kind === 'message' && data.text) addMessage('assistant', data.text, data.itemId);
  if (data.kind === 'tool') addMessage('tool', `${data.action}: ${data.state}${data.message ? ` · ${data.message}` : ''}`);
  if (data.kind === 'complete') { setBusy(false); if (data.error) { status(data.error); addMessage('error', data.error); } else status(data.status === 'interrupted' ? 'Task stopped.' : 'Task complete.'); }
  if (data.kind === 'error') { setBusy(false); status(data.message); addMessage('error', data.message); }
});
$('address-form').onsubmit = e => { e.preventDefault(); let url = $('address').value.trim(); if (!url) return; if (!/^\w+:/.test(url)) url = /\s/.test(url) || !url.includes('.') && !url.startsWith('localhost') ? `https://www.google.com/search?q=${encodeURIComponent(url)}` : `https://${url}`; action({ action: browserState?.tabs.length ? 'navigate' : 'open', url }); };
for (const name of ['back','forward','reload']) $(name).onclick = () => action({ action: name });
$('add-tab').onclick = () => action({ action: 'open', url: 'https://example.com/' });
$('gateway-tab').onclick = () => action({ action: 'open', url: 'http://127.0.0.1:4000/overview' });
$('connect').onclick = connect;
$('stop').onclick = async () => { try { await window.relay.stop(); } catch (e) { status(e.message); } };
$('new-chat').onclick = async () => { try { await window.relay.newChat(); messages.clear(); $('messages').replaceChildren(); status('New conversation ready. Browser tabs and sign-ins are unchanged.'); } catch(e) { status(e.message); } };
$('chat-form').onsubmit = async e => {
  e.preventDefault(); if (busy) return; const text = $('prompt').value.trim(); if (!text) return;
  const allowActions = $('allow-actions').checked; setBusy(true); addMessage('user', text); $('prompt').value = ''; status('Working with your browser…');
  try { await window.relay.chat({ text, model: $('model').value, allowActions }); } catch(e) { setBusy(false); status(e.message); addMessage('error', e.message); }
};
$('prompt').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chat-form').requestSubmit(); } };
for (const button of document.querySelectorAll('[data-prompt]')) button.onclick = () => { $('prompt').value = button.dataset.prompt; $('prompt').focus(); };
new ResizeObserver(layout).observe($('browser-host')); window.addEventListener('resize', layout);
window.relay.state().then(value => { renderBrowser(value.browser); $('gateway').textContent = value.gateway.online ? `Gateway · Account ${(value.gateway.active || '').toUpperCase()}` : 'Gateway offline · browser ready'; if (value.agent.ready) { connected = true; populateModels(value.agent.models); } setBusy(value.agent.busy); refreshApi().catch(()=>{}); }).catch(e => status(e.message));

async function refreshApi(){
  const state=await window.relay.browser({action:'api_operations'});$('api-count').textContent=`${state.operations.length} saved · API Anything`;
  const captured=browserState?.activeTabId?await window.relay.browser({action:'api_requests',tabId:browserState.activeTabId}):{requests:[]};
  $('api-request').replaceChildren();for(const item of captured.requests){const option=document.createElement('option');option.value=item.id;option.textContent=`${item.method} ${item.url}`;$('api-request').append(option);}
  $('api-state').textContent=`${captured.capturing?'Recording · ':''}${captured.requests.length} JSON requests in this tab. ${state.operations.length} saved operations available to apps and agents.`;
}
for(const [id,name]of [['api-start','api_capture_start'],['api-stop','api_capture_stop']])$(id).onclick=async()=>{try{await window.relay.browser({action:name,tabId:browserState.activeTabId});await refreshApi();}catch(e){$('api-state').textContent=e.message;}};
$('api-refresh').onclick=()=>refreshApi().catch(e=>{$('api-state').textContent=e.message;});
$('api-learn').onclick=async()=>{try{const split=id=>$(id).value.split(',').map(s=>s.trim()).filter(Boolean);const saved=await window.relay.browser({action:'api_learn',tabId:browserState.activeTabId,captureId:$('api-request').value,name:$('api-name').value,readOnly:$('api-readonly').checked,queryParams:split('api-query-params'),bodyParams:split('api-body-params')});await refreshApi();$('api-state').textContent=`Saved ${saved.name}. Ask the assistant to use api_operations, api_plan and api_call.`;}catch(e){$('api-state').textContent=e.message;}};
