'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('relay', {
  state: () => ipcRenderer.invoke('workspace-state'),
  browser: action => ipcRenderer.invoke('browser-action', action),
  bounds: value => ipcRenderer.invoke('browser-bounds', value),
  approve: (id, approved) => ipcRenderer.invoke('browser-approval', { id, approved }),
  actionPermissions: input => ipcRenderer.invoke('action-permissions', input),
  connect: () => ipcRenderer.invoke('agent-connect'),
  chat: input => ipcRenderer.invoke('agent-chat', input),
  stop: () => ipcRenderer.invoke('agent-stop'),
  newChat: () => ipcRenderer.invoke('agent-new'),
  onEvent: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('workspace-event', listener); return () => ipcRenderer.removeListener('workspace-event', listener); }
});
