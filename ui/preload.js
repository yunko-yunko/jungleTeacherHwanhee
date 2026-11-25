'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (action, payload) => ipcRenderer.invoke('jungle:command', action, payload);
contextBridge.exposeInMainWorld('jungle', Object.freeze({
  getState: () => invoke('get-state'),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('jungle:state', listener);
    return () => ipcRenderer.removeListener('jungle:state', listener);
  },
  observeCamp: (campId, status) => invoke('observe', { campId, status }),
  completeNext: target => invoke('complete-next', target),
  updateSettings: settings => invoke('settings', settings),
  setMode: mode => invoke('mode', mode),
  toggleOverlay: () => invoke('toggle-overlay'),
  toggleLock: () => invoke('toggle-lock'),
  closeWindow: () => invoke('close'),
  minimizeWindow: () => invoke('minimize')
}));
