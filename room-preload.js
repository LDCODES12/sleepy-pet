const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  closeRoom: () => ipcRenderer.send('close-room')
});
