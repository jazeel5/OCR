const { _electron: electron, expect } = require('../frontend/node_modules/@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-electron-'));
  let application;
  try {
    const env = { ...process.env, OCR_DESKTOP_TEST_DATA: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ executablePath: process.env.OCR_DESKTOP_EXECUTABLE || require('electron'),
      args: process.env.OCR_DESKTOP_EXECUTABLE ? [] : [__dirname],
      env, timeout: 60000 });
    // Release tests must not contact GitHub before this build is published.
    await application.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule('node:module');
      const req = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'main.cjs'));
      req('electron-updater').autoUpdater.checkForUpdates = async () => null;
    });
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('button', { name: 'Choose a document' })).toBeEnabled({ timeout: 60000 });
    await expect(page.evaluate(() => typeof window.require)).resolves.toBe('undefined');
    const unauthorized = await fetch(`${new URL(page.url()).origin}/api/health`);
    expect(unauthorized.status).toBe(401);
    await page.locator('input[type=file]').setInputFiles(path.join(__dirname, '../frontend/tests/fixtures/letter-photo.png'));
    const editor = page.locator('#page-1');
    await expect(editor).toContainText('POWER TRANSMISSION', { timeout: 60000 });
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
    await page.locator('input[type=file]').setInputFiles(path.join(__dirname, '../frontend/tests/fixtures/native.pdf'));
    await expect(page.getByRole('textbox', { name: /Embedded PDF text/ })).toHaveValue('Hello native PDF', { timeout: 30000 });
    await expect(page.locator('iframe')).toBeVisible();
    expect(errors).toEqual([]);
    await require('./test-update-download.cjs')(application, temp);
    console.log('Desktop passed: startup, private API, sandbox, photo OCR, editable tables, CSV export, text editing, clipboard, text export, native PDF.');
    await page.screenshot({ path: path.join(__dirname, '.cache/desktop-smoke.png') });
  } finally { await application?.close(); await fs.rm(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
