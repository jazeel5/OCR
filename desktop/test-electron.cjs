const { _electron: electron, expect } = require('../frontend/node_modules/@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');

// OCR has a 150s document deadline, the API allows 180s, and the UI allows
// 190s. Observe the response before checking the editor so a slow Windows
// runner can finish and service errors are reported instead of "not found".
const UPLOAD_TIMEOUT_MS = 200000;
const diagnostics = path.join(__dirname, 'test-results', 'desktop-smoke');

async function uploadDocument(page, filename) {
  const started = Date.now();
  console.log(`Processing ${filename}...`);
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/upload'
      && response.request().method() === 'POST', { timeout: UPLOAD_TIMEOUT_MS }),
    page.locator('input[type=file]').setInputFiles(path.join(__dirname, '../frontend/tests/fixtures', filename)),
  ]);
  const body = await response.text();
  console.log(`${filename}: HTTP ${response.status()} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  expect(response.status(), `${filename}: ${body}`).toBe(200);
  expect(JSON.parse(body).success, `${filename}: ${body}`).toBe(true);
}

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-electron-'));
  // CI exercises the offline path without Google credentials or billable calls.
  await fs.writeFile(path.join(temp, 'settings.env'), 'OCR_PROVIDER=tesseract\nTESSERACT_LANG=eng\n');
  let application;
  let page;
  let userData = temp;
  const errors = [];
  const networkErrors = [];
  await fs.rm(diagnostics, { recursive: true, force: true });
  await fs.mkdir(diagnostics, { recursive: true });
  try {
    const env = { ...process.env, OCR_DESKTOP_TEST_DATA: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ executablePath: process.env.OCR_DESKTOP_EXECUTABLE || require('electron'),
      args: [...(process.env.OCR_DESKTOP_EXECUTABLE ? [] : [__dirname]), `--user-data-dir=${temp}`],
      env, timeout: 60000 });
    // Release tests must not contact GitHub before this build is published.
    userData = await application.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule('node:module');
      const req = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'main.cjs'));
      req('electron-updater').autoUpdater.checkForUpdates = async () => null;
      return app.getPath('userData');
    });
    expect(userData).toBe(temp);
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => networkErrors.push(`${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
    await expect(page.getByRole('button', { name: 'Choose a document' })).toBeEnabled({ timeout: 60000 });
    await expect(page.evaluate(() => typeof window.require)).resolves.toBe('undefined');
    const unauthorized = await fetch(`${new URL(page.url()).origin}/api/health`);
    expect(unauthorized.status).toBe(401);
    await page.getByRole('button', { name: 'OCR settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'OCR settings' })).toBeVisible();
    await page.getByLabel('Recognition service').selectOption('google');
    await expect(page.getByRole('button', { name: 'Save and restart' })).toBeDisabled();
    const publicSettings = await page.evaluate(() => window.ocrDesktop.getSettings());
    expect(publicSettings.provider).toBe('tesseract');
    expect(publicSettings).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS');
    // Test the native picker and private storage with a generated test key.
    // No Google request is made and the service keeps its offline configuration.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const keyFile = path.join(temp, 'test-key.json');
    await fs.writeFile(keyFile, JSON.stringify({ type: 'service_account', project_id: 'ocr-test-project',
      private_key: privateKey, client_email: 'ocr@ocr-test-project.iam.gserviceaccount.com', token_uri: 'https://oauth2.googleapis.com/token' }));
    await application.evaluate(({ dialog }, filename) => {
      const original = dialog.showOpenDialog;
      dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [filename] }; };
    }, keyFile);
    await page.getByRole('button', { name: 'Select credentials JSON' }).click();
    await expect(page.getByText('Project: ocr-test-project', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(diagnostics, 'google-settings.png') });
    const saved = await page.evaluate(() => window.ocrDesktop.saveSettings({ provider: 'google', localLanguage: 'eng', cloudLanguage: 'en,kn' }));
    expect(saved.credentialConfigured).toBe(true);
    expect(saved.projectId).toBe('ocr-test-project');
    expect(JSON.stringify(saved)).not.toContain('PRIVATE KEY');
    const offline = await page.evaluate(() => window.ocrDesktop.saveSettings({ provider: 'tesseract', localLanguage: 'eng', cloudLanguage: '' }));
    expect(offline.provider).toBe('tesseract');
    await page.getByRole('button', { name: 'Close settings' }).click();
    await uploadDocument(page, 'letter-photo.png');
    const editor = page.locator('#page-1');
    await expect(editor).toContainText('POWER TRANSMISSION');
    await expect(page.getByRole('table').first()).toBeVisible();
    await page.getByRole('textbox', { name: 'Page 1 table 1 row 1 column 1', exact: true }).fill('Serial number');
    const csvOutput = path.join(temp, 'edited-table.csv');
    await application.evaluate(({ session }, destination) => {
      session.fromPartition('ocr-nexus').once('will-download', (_event, item) => item.setSavePath(destination));
    }, csvOutput);
    await page.getByRole('button', { name: 'Download CSV' }).first().click();
    await expect.poll(async () => { try { return await fs.readFile(csvOutput, 'utf8'); } catch { return ''; } }).toContain('"Serial number"');
    await editor.fill('Corrected desktop document 123');
    await page.getByRole('button', { name: 'Copy text' }).click();
    await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe('Corrected desktop document 123');
    expect(await application.evaluate(({ Menu }) => !!Menu.getApplicationMenu().getMenuItemById('check-updates'))).toBe(true);
    const output = path.join(temp, 'edited-document.txt');
    await application.evaluate(({ session }, destination) => {
      session.fromPartition('ocr-nexus').once('will-download', (_event, item) => item.setSavePath(destination));
    }, output);
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await expect.poll(async () => { try { return await fs.readFile(output, 'utf8'); } catch { return ''; } }).toBe('Corrected desktop document 123');
    await page.getByRole('button', { name: 'Process another document' }).click();
    await uploadDocument(page, 'native.pdf');
    await expect(page.getByRole('textbox', { name: /Embedded PDF text/ })).toHaveValue('Hello native PDF');
    await expect(page.locator('iframe')).toBeVisible();
    expect(errors).toEqual([]);
    await require('./test-update-download.cjs')(application, temp);
    console.log('Desktop passed: startup, private API, sandbox, Google settings and native credential picker, photo OCR, editable tables, CSV export, text editing, clipboard, text export, native PDF.');
    await page.screenshot({ path: path.join(diagnostics, 'success.png') });
  } catch (error) {
    await fs.writeFile(path.join(diagnostics, 'failure.txt'), `${error.stack}\n${[...errors, ...networkErrors].join('\n')}\n`);
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(diagnostics, 'failure.png'), timeout: 5000 }).catch(() => {});
      await fs.writeFile(path.join(diagnostics, 'screen.txt'), await page.locator('body').innerText({ timeout: 5000 }).catch(() => 'Window unavailable.'));
    }
    throw error;
  } finally {
    try {
      const log = await fs.readFile(path.join(userData, 'desktop.log'), 'utf8');
      await fs.writeFile(path.join(diagnostics, 'desktop.log'), log);
      console.log(`Desktop diagnostics:\n${log}`);
    } catch { /* Startup may fail before the app creates its log. */ }
    try { await application?.close(); }
    finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
