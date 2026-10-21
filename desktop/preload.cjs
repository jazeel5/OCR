const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ocrDesktop', {
  getSettings: () => ipcRenderer.invoke('ocr:settings'),
  chooseGoogleCredentials: () => ipcRenderer.invoke('ocr:choose-credentials'),
  saveSettings: settings => ipcRenderer.invoke('ocr:save-settings', settings),
  restart: () => ipcRenderer.invoke('ocr:restart'),
  openSetupGuide: () => ipcRenderer.invoke('ocr:setup-guide'),
});
