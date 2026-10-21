const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startRuntime, allowedToken } = require('../runtime.cjs');

test('desktop starts private services, extracts a photo and stops Python', { timeout: 60000 }, async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-desktop-'));
  let runtime;
  try {
    runtime = await startRuntime({ userData, log: message => process.stderr.write(message) });
    assert.equal((await fetch(`${runtime.url}/api/health`)).status, 401);
    const headers = { 'X-OCR-Token': runtime.token };
    assert.equal((await fetch(`${runtime.url}/api/health`, { headers })).status, 200);
    const home = await fetch(runtime.url, { headers });
    assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await home.text(), /<div id="root">/);
    const form = new FormData();
    form.append('file', new Blob([await fs.readFile(path.join(__dirname, '../../frontend/tests/fixtures/letter-photo.png'))],
      { type: 'image/png' }), 'letter-photo.png');
    const response = await fetch(`${runtime.url}/api/upload`, { method: 'POST', headers, body: form });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.match(data.text, /POWER TRANSMISSION/);
    assert.ok(data.page_results[0].tables.length > 0);
    await runtime.stop();
    assert.throws(() => process.kill(runtime.pid, 0), { code: 'ESRCH' });
    await assert.rejects(fetch(`${runtime.url}/api/health`, { headers }));
    assert.match(await fs.readFile(path.join(userData, 'settings.env'), 'utf8'), /OCR_PROVIDER=tesseract/);
  } finally { await runtime?.stop(); await fs.rm(userData, { recursive: true, force: true }); }
});

test('desktop rejects an invalid token without comparison errors', () => {
  assert.equal(allowedToken(undefined, 'secret'), false);
  assert.equal(allowedToken('secrex', 'secret'), false);
  assert.equal(allowedToken('secret', 'secret'), true);
});

test('desktop reports missing Python and cleans up startup', { timeout: 10000 }, async () => {
  const previous = process.env.OCR_DESKTOP_PYTHON;
  process.env.OCR_DESKTOP_PYTHON = path.join(os.tmpdir(), 'not-a-python-runtime');
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-desktop-fail-'));
  try { await assert.rejects(startRuntime({ userData }), /ENOENT/); }
  finally {
    if (previous) process.env.OCR_DESKTOP_PYTHON = previous;
    else delete process.env.OCR_DESKTOP_PYTHON;
    await fs.rm(userData, { recursive: true, force: true });
  }
});
