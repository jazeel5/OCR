const CHECK_INTERVAL_MS = 15 * 60 * 1000;

// Keep update prompts independent of the renderer. Documents never cross IPC.
function createUpdateController({ updater, enabled, currentVersion, showDialog,
  beforeInstall = async () => {}, onInstallFailure = () => {}, onState = () => {}, log = () => {},
  initialDelayMs = 5000, intervalMs = CHECK_INTERVAL_MS }) {
  let disposed = false;
  let operation = null;
  let state = 'idle';
  let downloaded = null;
  let cancellation = null;
  let manualRequested = false;
  let timer;
  let interval;
  let installFailureHandled = false;
  const deferredVersions = new Set();

  const transition = (next, progress = null) => {
    state = next;
    if (!disposed) onState({ state, progress, version: downloaded?.version });
  };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  updater.logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level =>
    [level, message => log(`Updater ${level}: ${String(message)}\n`)]));

  async function installFailed(error) {
    if (installFailureHandled || disposed) return;
    installFailureHandled = true;
    transition('failed');
    log(`Update installation failed: ${error.message}\n`);
    try {
      await showDialog({ type: 'error', title: 'Update could not be installed',
        message: 'OCR Nexus will reopen with your current version.',
        detail: 'Try updating again from Help → Check for updates.', buttons: ['OK'] });
    } finally { if (!disposed) onInstallFailure(); }
  }
  const onError = error => {
    log(`Updater error: ${error.message}\n`);
    // Check/download errors also reject their promises. Install errors are events.
    if (state === 'installing') void installFailed(error);
  };
  const onProgress = info => {
    if (state === 'downloading') transition('downloading', Math.max(0, Math.min(100, info.percent)));
  };
  updater.on('error', onError);
  updater.on('download-progress', onProgress);

  async function offerInstall() {
    if (disposed) return;
    const { response } = await showDialog({ type: 'info', title: 'Update ready',
      message: `OCR Nexus ${downloaded.version} is ready to install.`,
      detail: 'Export any text or table edits before restarting. Unsaved work will be lost. Choose Later to keep working.',
      buttons: ['Restart and install', 'Later'], defaultId: 1, cancelId: 1, noLink: true });
    if (response !== 0 || disposed) return;
    transition('installing');
    try {
      await beforeInstall(); // Release Python/Tesseract DLLs before NSIS replaces them.
      if (!disposed) updater.quitAndInstall(false, true);
    } catch (error) { await installFailed(error); }
  }

  async function performCheck() {
    if (downloaded) { await offerInstall(); return; }
    transition('checking');
    let userAcceptedDownload = false;
    try {
      const result = await updater.checkForUpdates();
      if (disposed) return;
      if (!result?.isUpdateAvailable) {
        transition('idle');
        if (manualRequested) await showDialog({ type: 'info', title: 'No updates available',
          message: `You are using the latest published version (${currentVersion}).`, buttons: ['OK'] });
        return;
      }
      const info = result.updateInfo;
      if (!manualRequested && deferredVersions.has(info.version)) { transition('idle'); return; }
      transition('available');
      deferredVersions.add(info.version);
      const { response } = await showDialog({ type: 'info', title: 'Update available',
        message: `OCR Nexus ${info.version} is available.`,
        detail: `You are using version ${currentVersion}. Download the update now and keep working until you choose to restart.`,
        buttons: ['Download update', 'Later'], defaultId: 0, cancelId: 1, noLink: true });
      if (response !== 0 || disposed) { transition('idle'); return; }
      userAcceptedDownload = true;
      cancellation = result.cancellationToken;
      transition('downloading', 0);
      await updater.downloadUpdate(cancellation);
      cancellation = null;
      if (disposed) return;
      downloaded = info;
      transition('downloaded');
      await offerInstall();
    } catch (error) {
      cancellation = null;
      if (disposed) return;
      transition(downloaded ? 'downloaded' : 'idle');
      log(`Update check/download failed: ${error.message}\n`);
      if (manualRequested || userAcceptedDownload) await showDialog({ type: 'warning', title: 'Update unavailable',
        message: 'The update could not be checked or downloaded.',
        detail: 'Check your internet connection and try Help → Check for updates again. You can continue using this version.',
        buttons: ['OK'] });
    }
  }

  function check(manual = false) {
    if (disposed || state === 'installing' || state === 'failed') return Promise.resolve();
    if (!enabled) {
      return manual ? showDialog({ type: 'info', title: 'Updates not configured',
        message: 'Automatic updates are available in the Windows build from GitHub Releases.',
        detail: 'Install that build once to receive future update prompts.', buttons: ['OK'] }) : Promise.resolve();
    }
    if (operation) { manualRequested ||= manual; return operation; }
    if (downloaded && !manual) return Promise.resolve();
    manualRequested = manual;
    operation = performCheck().finally(() => { operation = null; manualRequested = false; });
    return operation;
  }

  return {
    check,
    getState: () => state,
    start() {
      if (!enabled || disposed || timer || interval) return;
      timer = setTimeout(() => { void check(); }, initialDelayMs);
      interval = setInterval(() => { void check(); }, intervalMs);
      timer.unref?.();
      interval.unref?.();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearInterval(interval);
      cancellation?.cancel();
      updater.off('download-progress', onProgress);
      // Keep the error listener: cancellation may emit after shutdown begins.
    },
  };
}

module.exports = { createUpdateController, CHECK_INTERVAL_MS };
