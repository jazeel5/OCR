const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateController } = require('../updates.cjs');

function fixture(responses = [], options = {}) {
  const updater = new EventEmitter();
  const calls = [];
  const dialogs = [];
  const states = [];
  const cancelled = [];
  updater.checkForUpdates = async () => {
    calls.push('check');
    return { isUpdateAvailable: true, updateInfo: { version: '2.2.2' },
      cancellationToken: { cancel: () => cancelled.push(true) } };
  };
  updater.downloadUpdate = async () => { calls.push('download'); updater.emit('download-progress', { percent: 42 }); return ['update.exe']; };
  updater.quitAndInstall = (...args) => calls.push(['install', ...args]);
  const controller = createUpdateController({ updater, enabled: true, currentVersion: '2.2.1',
    showDialog: async dialog => { dialogs.push(dialog); return { response: responses.shift() ?? 1 }; },
    onState: state => states.push(state), beforeInstall: async () => { calls.push('stop-services'); },
    onInstallFailure: () => calls.push('reopen'), ...options });
  return { updater, controller, calls, dialogs, states, cancelled };
}

test('download and installation need separate consent; services close before install', async () => {
  const f = fixture([0, 0]);
  await f.controller.check();
  assert.equal(f.updater.autoDownload, false);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.allowDowngrade, false);
  assert.deepEqual(f.calls, ['check', 'download', 'stop-services', ['install', false, true]]);
  assert.deepEqual(f.dialogs.map(d => d.title), ['Update available', 'Update ready']);
  assert.match(f.dialogs[1].detail, /Export any text or table edits/);
  assert.equal(f.dialogs[1].defaultId, 1);
  assert.ok(f.states.some(s => s.state === 'downloading' && s.progress === 42));
  f.controller.dispose();
});

test('Later suppresses repeated automatic prompts but manual checks can retry', async () => {
  const f = fixture([1, 1]);
  await f.controller.check();
  await f.controller.check();
  assert.equal(f.dialogs.length, 1);
  assert.ok(!f.calls.includes('download'));
  await f.controller.check(true);
  assert.equal(f.dialogs.length, 2);
  f.controller.dispose();
});

test('a downloaded update can be installed later without downloading again', async () => {
  const f = fixture([0, 1, 0]);
  await f.controller.check();
  assert.equal(f.controller.getState(), 'downloaded');
  await f.controller.check();
  assert.equal(f.dialogs.length, 2);
  await f.controller.check(true);
  assert.equal(f.calls.filter(c => c === 'download').length, 1);
  assert.equal(f.calls.filter(c => c === 'check').length, 1);
  assert.deepEqual(f.calls.at(-1), ['install', false, true]);
  f.controller.dispose();
});

test('offline checks are quiet automatically, and useful when explicitly requested', async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => { const error = new Error('offline'); f.updater.emit('error', error); throw error; };
  await f.controller.check();
  assert.equal(f.dialogs.length, 0);
  await f.controller.check(true);
  assert.equal(f.dialogs[0].title, 'Update unavailable');
  assert.equal(f.controller.getState(), 'idle');
  f.controller.dispose();
});

test('a failed download never installs and can be retried manually', async () => {
  const f = fixture([0, 0, 0, 1]);
  f.updater.downloadUpdate = async () => { throw new Error('invalid checksum'); };
  await f.controller.check();
  assert.equal(f.dialogs.at(-1).title, 'Update unavailable');
  assert.ok(!f.calls.includes('stop-services'));
  f.updater.downloadUpdate = async () => ['update.exe'];
  await f.controller.check(true);
  assert.equal(f.controller.getState(), 'downloaded');
  f.controller.dispose();
});

test('simultaneous checks share a single request and honor a manual check', async () => {
  const f = fixture();
  let resolve;
  let checks = 0;
  f.updater.checkForUpdates = () => { checks++; return new Promise(done => { resolve = done; }); };
  const first = f.controller.check();
  const second = f.controller.check(true);
  assert.equal(first, second);
  resolve({ isUpdateAvailable: false });
  await first;
  assert.equal(checks, 1);
  assert.equal(f.dialogs[0].title, 'No updates available');
  f.controller.dispose();
});

test('shutdown cancels a download and does not show more dialogs or install', async () => {
  const f = fixture([0]);
  let done;
  f.updater.downloadUpdate = () => new Promise(resolve => { done = resolve; });
  const check = f.controller.check();
  await new Promise(resolve => setImmediate(resolve));
  f.controller.dispose();
  assert.deepEqual(f.cancelled, [true]);
  done(['update.exe']);
  await check;
  assert.equal(f.dialogs.length, 1);
  assert.ok(!f.calls.includes('stop-services'));
});

test('an installation failure reopens the current app after stopping services', async () => {
  const f = fixture([0, 0, 0]);
  f.updater.quitAndInstall = () => { f.updater.emit('error', new Error('installer missing')); };
  await f.controller.check();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.dialogs.at(-1).title, 'Update could not be installed');
  assert.equal(f.controller.getState(), 'failed');
  assert.equal(f.calls.at(-1), 'reopen');
  f.controller.dispose();
});

test('local builds never contact an unconfigured update feed', async () => {
  const f = fixture([], { enabled: false });
  f.controller.start();
  await f.controller.check();
  assert.deepEqual(f.calls, []);
  await f.controller.check(true);
  assert.equal(f.dialogs[0].title, 'Updates not configured');
  f.controller.dispose();
});

test('automatic checks run at startup and continue while the app stays open', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture([1], { initialDelayMs: 5000, intervalMs: 900000 });
  f.controller.start();
  t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  t.mock.timers.tick(900000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 2);
  f.controller.dispose();
  t.mock.timers.tick(900000);
  assert.equal(f.calls.length, 2);
});
