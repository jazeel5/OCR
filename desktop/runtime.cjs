const { spawn } = require('node:child_process');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const path = require('node:path');
const readline = require('node:readline');
const express = require('express');
const { readSettings } = require('./settings.cjs');

function allowedToken(provided, token) {
  const input = Buffer.from(provided || '');
  const expected = Buffer.from(token);
  return input.length === expected.length && timingSafeEqual(input, expected);
}

async function startRuntime({ packaged = false, resourcesPath, userData, log = () => {}, onExit = () => {} }) {
  const root = path.resolve(__dirname, '..');
  const resources = packaged ? resourcesPath : root;
  const token = randomBytes(32).toString('hex');
  const serviceDir = path.join(resources, 'ocr-service');
  const python = packaged ? path.join(resources, 'python', 'python.exe')
    : process.env.OCR_DESKTOP_PYTHON || path.join(serviceDir, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const settings = readSettings(userData);
  const env = { ...process.env, ...settings, OCR_PROVIDER: settings.OCR_PROVIDER || 'google',
    // Documents already run in separate workers. Avoid competing OpenMP
    // threads on smaller PCs and shared Windows build runners.
    OMP_THREAD_LIMIT: process.env.OMP_THREAD_LIMIT || '1',
    OCR_DESKTOP_TOKEN: token, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' };
  // New installations should open the setup screen without probing external
  // ADC locations or a cloud metadata server for missing credentials.
  if (env.OCR_PROVIDER === 'google' && !settings.GOOGLE_APPLICATION_CREDENTIALS) {
    env.GOOGLE_APPLICATION_CREDENTIALS = path.join(userData, 'google-credentials-not-configured.json');
  }
  if (packaged) {
    env.TESSERACT_CMD = path.join(resources, 'tesseract', 'tesseract.exe');
    env.TESSDATA_PREFIX = path.join(resources, 'tesseract', 'tessdata');
    // Windows often spells this variable "Path"; avoid conflicting duplicate keys.
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = `${path.join(resources, 'tesseract')}${path.delimiter}${env[pathKey] || ''}`;
  }
  const child = spawn(python, ['-X', 'utf8', '-B', path.join(serviceDir, 'desktop_service.py')], {
    cwd: userData, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stopped = false;
  let server;
  let childEnded = false;
  child.on('error', () => { childEnded = true; });
  child.stderr.on('data', chunk => log(chunk.toString()));
  child.stdin.on('error', () => {}); // The service may fail before stdin is closed.
  child.on('exit', (code, signal) => {
    childEnded = true;
    log(`OCR service exited (${code ?? signal}).\n`);
    if (!stopped) onExit(code, signal);
  });

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (server) { server.closeAllConnections(); server.close(); }
    child.stdin.end();
    if (!childEnded) await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  try {
    const ocrPort = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('OCR startup timed out.')), 60000);
      const lines = readline.createInterface({ input: child.stdout });
      const fail = () => finish(new Error('The OCR service could not start. See the desktop log for details.'));
      const finish = (error, port) => {
        clearTimeout(timer);
        lines.close();
        child.off('error', finish);
        child.off('exit', fail);
        error ? reject(error) : resolve(port);
      };
      child.once('error', finish);
      child.once('exit', fail);
      lines.on('line', line => {
        try {
          const message = JSON.parse(line);
          if (message.event === 'listening' && Number.isInteger(message.port) && message.port > 0 && message.port < 65536) finish(null, message.port);
        } catch { log(`${line}\n`); }
      });
    });
    child.stdout.on('data', chunk => log(chunk.toString()));
    const ocrUrl = `http://127.0.0.1:${ocrPort}`;
    const privateFetch = (url, options = {}) => fetch(url, { ...options,
      headers: { ...options.headers, 'X-OCR-Token': token } });
    let healthy = false;
    for (let attempt = 0; attempt < 100 && !childEnded; attempt++) {
      try {
        const response = await privateFetch(`${ocrUrl}/health`, { signal: AbortSignal.timeout(2000) });
        const health = await response.json();
        if (response.ok || (response.status === 503 && health.status === 'unavailable')) {
          healthy = true; break; // Keep settings accessible when the provider needs setup.
        }
        if (attempt === 0) log(`OCR health check: ${JSON.stringify(health)}\n`);
      } catch { /* Wait for uvicorn startup. */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!healthy) throw new Error('OCR is unavailable. Check the desktop log and OCR settings.');
    const { createApp } = require(packaged ? './backend/server.js' : '../backend/server.js');
    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
      if (!allowedToken(req.get('X-OCR-Token'), token)) return res.status(401).json({ error: 'Unauthorized' });
      res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; frame-src 'self' blob:; object-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
      res.set('X-Content-Type-Options', 'nosniff');
      next();
    });
    app.use(createApp({ ocrUrl, fetchImpl: privateFetch }));
    app.use(express.static(path.join(resources, packaged ? 'frontend' : 'frontend/dist'), { dotfiles: 'deny' }));
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    server.requestTimeout = 200000;
    return { url: `http://127.0.0.1:${server.address().port}`, token, stop, pid: child.pid };
  } catch (error) { await stop(); throw error; }
}

module.exports = { startRuntime, allowedToken };
