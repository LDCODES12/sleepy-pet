const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  quit: () => ipcRenderer.send('quit-app'),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  openRoom: () => ipcRenderer.send('open-room'),
  toggleFollow: (enabled) => ipcRenderer.send('toggle-follow', enabled),
  hideMochi: () => ipcRenderer.send('hide-mochi'),
  onStopFollow: (cb) => ipcRenderer.on('stop-follow', cb),
  onFollowState: (cb) => ipcRenderer.on('follow-state', (_, enabled) => cb(enabled)),
  onCursorDir: (cb) => ipcRenderer.on('cursor-dir', (_, dir) => cb(dir)),
  onMochiVisible: (cb) => ipcRenderer.on('mochi-visible', (_, visible) => cb(visible)),
  onOpenMenu: (cb) => ipcRenderer.on('open-menu', cb)
});
