'use strict';
async function refreshBrowserWorkspace() {
  const target = document.getElementById('browser-workspace-state'); if (!target) return;
  try { const result = await api('/admin/browser/status'); target.textContent = result.running ? `Browser open · ${result.tabs.length} tabs · ${result.agentBusy ? 'AI task running' : 'ready'}` : 'Browser closed · website sessions stay saved locally'; }
  catch (e) { target.textContent = e.message; }
}
async function launchBrowserWorkspace() {
  const button = document.getElementById('launch-browser-workspace'); button.disabled = true;
  try { const result = await api('/admin/browser/launch', 'POST'); notify(result.message); setTimeout(refreshBrowserWorkspace, 2500); }
  catch (e) { notify(e.message); } finally { button.disabled = false; }
}
if (document.body.dataset.page === 'browser') refreshBrowserWorkspace();
setInterval(() => { if (document.body.dataset.page === 'browser') refreshBrowserWorkspace(); }, 5000);
