// Only these two calls reach the app's main process from the page.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('notesApp', {
  openAbout: () => ipcRenderer.invoke('open-about'),
  version: () => ipcRenderer.invoke('app-version'),
});
