const { app, BrowserWindow, Menu, dialog, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { startRuntime } = require('./runtime.cjs');
const { createUpdateController } = require('./updates.cjs');

if (process.env.OCR_DESKTOP_TEST_DATA && !app.isPackaged) app.setPath('userData', process.env.OCR_DESKTOP_TEST_DATA);
app.setName('OCR Nexus');
app.setAppUserModelId('com.ocrnexus.desktop');
let window;
let runtime;
let quitting = false;
let starting = true;
let updates;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    fs.mkdirSync(userData, { recursive: true });
    const logPath = path.join(userData, 'desktop.log');
    // Keep the previous launch's diagnostics, without accumulating document data.
    if (fs.existsSync(logPath)) fs.renameSync(logPath, `${logPath}.previous`);
    const log = message => fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}`);
    const privateSession = session.fromPartition('ocr-nexus'); // In memory; no document cache on disk.
    privateSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
    privateSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write');
    privateSession.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
    });
    window = new BrowserWindow({ width: 1280, height: 900, minWidth: 800, minHeight: 600,
      title: 'OCR Nexus', backgroundColor: '#f8fafc',
      webPreferences: { session: privateSession, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (!runtime || new URL(url).origin !== runtime.url) event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (runtime && url.startsWith(`blob:${runtime.url}/`)) return { action: 'allow', overrideBrowserWindowOptions: {
        title: 'Original document', webPreferences: { session: privateSession, nodeIntegration: false, contextIsolation: true, sandbox: true },
      } };
      return { action: 'deny' };
    });
    window.on('closed', () => { window = null; if (!quitting) app.quit(); });
    updates = createUpdateController({
      updater: require('electron-updater').autoUpdater,
      enabled: app.isPackaged && process.platform === 'win32' && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')),
      currentVersion: app.getVersion(), log,
      showDialog: options => window && !window.isDestroyed()
        ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options),
      beforeInstall: async () => { await runtime?.stop(); },
      onInstallFailure: () => { app.relaunch(); app.quit(); },
      onState: ({ state, progress }) => {
        if (window && !window.isDestroyed()) window.setProgressBar(state === 'downloading' ? (progress ?? 0) / 100 : -1);
        const item = Menu.getApplicationMenu()?.getMenuItemById('check-updates');
        if (!item) return;
        item.enabled = !['checking', 'available', 'downloading', 'installing', 'failed'].includes(state);
        item.label = state === 'downloading' ? `Downloading update… ${Math.round(progress ?? 0)}%`
          : state === 'downloaded' ? 'Restart to install update…'
            : state === 'checking' ? 'Checking for updates…' : 'Check for updates…';
      },
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'File', submenu: [{ label: 'OCR settings folder', click: () => shell.openPath(userData) },
        { type: 'separator' }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { label: 'Help', submenu: [{ id: 'check-updates', label: 'Check for updates…', click: () => { void updates.check(true); } },
        { type: 'separator' }, { label: 'About OCR Nexus', click: () => dialog.showMessageBox(window, {
        type: 'info', title: 'OCR Nexus', message: `OCR Nexus ${app.getVersion()}`,
        detail: 'Extract editable text and tables from PDFs and photos. Local OCR works offline. Review important numbers and handwriting before use.',
      }) }] },
    ]));
    await window.loadFile(path.join(__dirname, 'loading.html'));
    try {
      runtime = await startRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, userData, log,
        onExit: () => {
          if (!starting && !quitting) {
            dialog.showErrorBox('OCR service stopped', `Please reopen OCR Nexus. Diagnostics: ${logPath}`);
            app.quit();
          }
        },
      });
      starting = false;
      if (quitting || !window) { await runtime.stop(); app.exit(0); return; }
      privateSession.webRequest.onBeforeSendHeaders({ urls: [`${runtime.url}/*`] }, (details, callback) => {
        callback({ requestHeaders: { ...details.requestHeaders, 'X-OCR-Token': runtime.token } });
      });
      await window.loadURL(runtime.url);
      updates.start();
    } catch (error) {
      starting = false;
      log(`${error.stack}\n`);
      if (!quitting) dialog.showErrorBox('Unable to start OCR Nexus', `${error.message}\n\nDiagnostics: ${logPath}`);
      if (quitting) app.exit(1);
      else app.quit();
    }
  }).catch(error => { dialog.showErrorBox('Unable to start OCR Nexus', error.message); app.exit(1); });

  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true;
    updates?.dispose();
    if (runtime) { event.preventDefault(); runtime.stop().finally(() => app.quit()); }
    // If startup is pending, keep Electron alive until its child can be closed.
    else if (starting) event.preventDefault();
  });
  app.on('window-all-closed', () => { if (!quitting) app.quit(); });
}
