const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  quit: () => ipcRenderer.send('quit-app'),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  openRoom: (mode) => ipcRenderer.send('open-room', mode),
  toggleFollow: (enabled) => ipcRenderer.send('toggle-follow', enabled),
  hideMochi: () => ipcRenderer.send('hide-mochi'),
  installUpdateNow: () => ipcRenderer.send('install-update-now'),
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  configurePetMessages: (config) => ipcRenderer.invoke('configure-pet-messages', config),
  sendPetMessage: (message) => ipcRenderer.invoke('send-pet-message', message),
  configureGroups: (config) => ipcRenderer.invoke('configure-groups', config),
  sendGroupMessage: (payload) => ipcRenderer.invoke('send-group-message', payload),
  openGroupRoom: (payload) => ipcRenderer.send('open-group-room', payload),
  updateCatState: (payload) => ipcRenderer.send('update-cat-state', payload),
  onStopFollow: (cb) => ipcRenderer.on('stop-follow', cb),
  onFollowState: (cb) => ipcRenderer.on('follow-state', (_, enabled) => cb(enabled)),
  onCursorDir: (cb) => ipcRenderer.on('cursor-dir', (_, dir) => cb(dir)),
  onMochiVisible: (cb) => ipcRenderer.on('mochi-visible', (_, visible) => cb(visible)),
  onOpenMenu: (cb) => ipcRenderer.on('open-menu', cb),
  onUpdateState: (cb) => ipcRenderer.on('update-state', (_, state) => cb(state)),
  onPetMessage: (cb) => ipcRenderer.on('pet-message-received', (_, message) => cb(message)),
  onPetMessageStatus: (cb) => ipcRenderer.on('pet-message-status', (_, status) => cb(status)),
  onGroupEvent: (cb) => ipcRenderer.on('group-event', (_, event) => cb(event))
});
