const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  showNotification: (title, body) => {
    ipcRenderer.send('show-notification', { title, body });
  },
  focusWindow: () => {
    ipcRenderer.send('focus-window');
  },
  onNotificationClick: (callback) => {
    ipcRenderer.on('notification-click', (event, data) => callback(data));
  }
});
