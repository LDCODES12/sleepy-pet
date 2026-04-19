const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  closeRoom: () => ipcRenderer.send('close-room'),
  onSetRoomMode: (cb) => ipcRenderer.on('set-room-mode', (_, payload) => cb(payload)),
  sendGroupMessage: (payload) => ipcRenderer.invoke('send-group-message', payload),
  getGroupSnapshot: (groupId) => ipcRenderer.invoke('get-group-snapshot', groupId),
  updateGroupRoomPresence: (payload) => ipcRenderer.send('update-group-room-presence', payload),
  onGroupEvent: (cb) => ipcRenderer.on('group-event', (_, event) => cb(event))
});
