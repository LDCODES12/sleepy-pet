const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  closeRoom: () => ipcRenderer.send('close-room'),
  onSetRoomMode: (cb) => ipcRenderer.on('set-room-mode', (_, mode) => cb(mode))
});
