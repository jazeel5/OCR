const http = require('node:http');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');

// Exercise the actual NSIS downloader and checksum verifier without executing
// an installer or using a live GitHub release. All cache files stay in temp.
module.exports = async function testUpdateDownload(application, temp) {
  const payload = Buffer.from('MZ test payload; never executed');
  const sha512 = createHash('sha512').update(payload).digest('base64');
  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0].endsWith('.yml')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ version: '99.0.0', files: [{ url: 'update.exe', sha512, size: payload.length }] }));
    } else {
      res.setHeader('Content-Length', payload.length);
      res.end(req.url.startsWith('/corrupt/') ? Buffer.alloc(payload.length) : payload);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const results = await application.evaluate(async ({ app }, { temp, baseUrl }) => {
      const fs = process.getBuiltinModule('node:fs');
      const path = process.getBuiltinModule('node:path');
      const req = process.getBuiltinModule('node:module').createRequire(path.join(app.getAppPath(), 'main.cjs'));
      const { NsisUpdater } = req('electron-updater');
      const { ElectronHttpExecutor } = req('electron-updater/out/electronHttpExecutor');
      const { createUpdateController } = req('./updates.cjs');
      const results = [];
      for (const mode of ['valid', 'corrupt']) {
        const directory = path.join(temp, mode);
        fs.mkdirSync(directory, { recursive: true });
        const config = path.join(directory, 'app-update.yml');
        fs.writeFileSync(config, JSON.stringify({ updaterCacheDirName: 'updater-cache' }));
        const adapter = { version: '2.2.0', name: 'OCR update test', isPackaged: true,
          appUpdateConfigPath: config, userDataPath: directory, baseCachePath: directory,
          whenReady: () => Promise.resolve(), onQuit: () => { throw new Error('Automatic installation must remain disabled.'); } };
        const updater = new NsisUpdater(null, adapter);
        updater.httpExecutor = new ElectronHttpExecutor();
        updater.disableDifferentialDownload = true;
        updater.setFeedURL({ provider: 'generic', url: `${baseUrl}/${mode}/` });
        updater.quitAndInstall = () => { throw new Error('Test installers must never execute.'); };
        const dialogs = [];
        const logs = [];
        const controller = createUpdateController({ updater, enabled: true, currentVersion: '2.2.0',
          log: message => logs.push(message),
          showDialog: async options => { dialogs.push(options.title); return { response: options.title === 'Update available' ? 0 : 1 }; } });
        await controller.check(true);
        results.push({ mode, state: controller.getState(), dialogs, logs,
          downloaded: updater.installerPath ? fs.readFileSync(updater.installerPath).toString() : null });
        controller.dispose();
      }
      return results;
    }, { temp, baseUrl: `http://127.0.0.1:${server.address().port}` });
    assert.equal(results[0].state, 'downloaded', JSON.stringify(results[0]));
    assert.equal(results[0].downloaded, payload.toString());
    assert.deepEqual(results[0].dialogs, ['Update available', 'Update ready']);
    assert.equal(results[1].state, 'idle');
    assert.equal(results[1].downloaded, null);
    assert.deepEqual(results[1].dialogs, ['Update available', 'Update unavailable']);
    assert.match(results[1].logs.join(''), /checksum mismatch/i);
    console.log('Real NSIS update download passed; corrupted payload rejected before installation.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
};
