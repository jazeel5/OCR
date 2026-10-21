import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';

const ready = { status: 'ready', provider: 'tesseract', processing_location: 'local', max_upload_bytes: 10485760, max_pages: 20 };
const mockResult = { success: true, filename: 'invoice.png', data: { text: 'Invoice 123', confidence: 94, pages: 1, provider: 'tesseract', warnings: [], page_results: [{ page: 1, text: 'Invoice 123', confidence: 94, engine: 'tesseract', word_count: 2 }] } };

test('desktop Google setup is accessible without credentials and saves only choices', async ({ page }) => {
  await page.addInitScript(() => {
    window.ocrDesktop = {
      getSettings: async () => ({ provider: 'google', localLanguage: 'eng', cloudLanguage: '', credentialConfigured: false, projectId: '' }),
      chooseGoogleCredentials: async () => ({ filename: 'test-key.json', projectId: 'ocr-test-project' }),
      saveSettings: async value => { window.savedSettings = value; return value; },
      restart: async () => { window.restartRequested = true; return { restarting: true }; },
      openSetupGuide: async () => ({ opened: true }),
    };
  });
  await page.route('**/api/health', route => route.fulfill({ status: 503, json: {
    ...ready, status: 'unavailable', provider: 'google', processing_location: 'google-cloud', error: 'Google OCR is not configured.' } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Choose a document' })).toBeDisabled();
  await page.getByRole('button', { name: 'Set up Google OCR' }).click();
  const dialog = page.getByRole('dialog', { name: 'OCR settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/usage may incur charges/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save and restart' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Select credentials JSON' }).click();
  await expect(dialog.getByText('Project: ocr-test-project')).toBeVisible();
  await dialog.getByLabel('Document language').selectOption('en,kn');
  await dialog.getByRole('button', { name: 'Save and restart' }).click();
  await expect.poll(() => page.evaluate(() => window.restartRequested)).toBe(true);
  expect(await page.evaluate(() => window.savedSettings)).toEqual({ provider: 'google', localLanguage: 'eng', cloudLanguage: 'en,kn' });
});

test('desktop can choose offline OCR without a Google key and recover from a failed save', async ({ page }) => {
  await page.addInitScript(() => {
    window.ocrDesktop = {
      getSettings: async () => ({ provider: 'google', localLanguage: 'eng', cloudLanguage: '', credentialConfigured: false }),
      saveSettings: async () => ({ error: 'Settings could not be saved. Try again.' }),
      restart: async () => { throw new Error('Must not restart after a failed save'); },
    };
  });
  await mockHealth(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'OCR settings', exact: true }).click();
  await page.getByLabel('Recognition service').selectOption('tesseract');
  await expect(page.getByRole('button', { name: 'Save and restart' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save and restart' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Settings could not be saved');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

async function mockHealth(page, data = ready) {
  await page.route('**/api/health', route => route.fulfill({ json: data }));
}

async function chooseSample(page) {
  await page.getByRole('button', { name: 'Choose a document' }).waitFor();
  await expect(page.getByRole('button', { name: 'Choose a document' })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/invoice.png');
}

test('real scanned image travels through frontend, backend, and OCR', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await chooseSample(page);
  const editor = page.getByRole('textbox', { name: /Page 1/ });
  await expect(editor).toContainText('12345', { timeout: 30000 });
  await expect(editor).toContainText('250.00');
  await expect(page.getByRole('img', { name: /Original document/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/review-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('real selectable PDF uses direct extraction', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Choose a document' })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/native.pdf');
  await expect(page.getByRole('textbox', { name: /Embedded PDF text/ })).toHaveValue('Hello native PDF');
  await expect(page.getByText(/OCR confidence:/)).toHaveCount(0);
});

test('edits are included in text and JSON downloads, and resetting works', async ({ page }) => {
  await mockHealth(page);
  await page.route('**/api/upload', route => route.fulfill({ json: mockResult }));
  await page.goto('/');
  await chooseSample(page);
  await page.getByRole('textbox', { name: /Page 1/ }).fill('Corrected invoice 456');
  await expect(page.getByRole('heading', { name: 'Extracted text (edited)' })).toBeVisible();
  const textDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  expect(await readFile(await (await textDownload).path(), 'utf8')).toBe('Corrected invoice 456');
  const jsonDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  const data = JSON.parse(await readFile(await (await jsonDownload).path(), 'utf8'));
  expect(data.edited).toBe(true);
  expect(data.page_results[0].text).toBe('Corrected invoice 456');
  await page.getByRole('button', { name: 'Process another document' }).click();
  await expect(page.getByRole('button', { name: 'Choose a document' })).toBeEnabled();
});

test('shows cloud disclosure and useful API errors; allows same-file retry', async ({ page }) => {
  await mockHealth(page, { ...ready, provider: 'google', processing_location: 'google-cloud' });
  let uploads = 0;
  await page.route('**/api/upload', route => {
    uploads++;
    return route.fulfill({ status: 422, json: { error: 'The image is corrupt or cannot be decoded.' } });
  });
  await page.goto('/');
  await expect(page.getByText('Pages requiring OCR are sent to Google Cloud Vision for text recognition.')).toBeVisible();
  await chooseSample(page);
  await expect(page.getByRole('alert')).toContainText('image is corrupt');
  await chooseSample(page);
  await expect.poll(() => uploads).toBe(2);
});

test('rejects oversized and unsupported files before sending them', async ({ page }) => {
  await mockHealth(page, { ...ready, max_upload_bytes: 10 });
  let uploads = 0;
  await page.route('**/api/upload', route => { uploads++; return route.abort(); });
  await page.goto('/');
  await chooseSample(page);
  await expect(page.getByRole('alert')).toContainText('non-empty file');
  await page.locator('input[type=file]').setInputFiles({ name: 'bad.html', mimeType: 'text/html', buffer: Buffer.from('bad') });
  await expect(page.getByRole('alert')).toContainText('Choose a PDF');
  expect(uploads).toBe(0);
});

test('handles cancellation and ignores duplicate drops during processing', async ({ page }) => {
  await mockHealth(page);
  let uploads = 0;
  await page.route('**/api/upload', async route => { uploads++; await new Promise(resolve => setTimeout(resolve, 1000)); await route.fulfill({ json: mockResult }); });
  await page.goto('/');
  await chooseSample(page);
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await expect.poll(() => uploads).toBe(1);
  await page.locator('[aria-busy=true]').evaluate(element => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['duplicate'], 'duplicate.png', { type: 'image/png' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
  });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Upload cancelled');
  await expect(page.getByRole('button', { name: 'Choose a document' })).toBeEnabled();
  expect(uploads).toBeLessThanOrEqual(1);
});

test('recovers from failed health checks and fits a mobile viewport', async ({ page }) => {
  let available = false;
  await page.route('**/api/health', route => !available
    ? route.fulfill({ status: 503, json: { error: 'OCR service is unavailable.' } })
    : route.fulfill({ json: ready }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('OCR service is unavailable');
  await expect(page.getByRole('button', { name: 'Choose a document' })).toBeDisabled();
  available = true;
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(page.getByRole('button', { name: 'Choose a document' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/upload-mobile.png', fullPage: true });
});

test('real photographed letter yields editable merged cells and CSV/JSON exports', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Choose a document' })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/letter-photo.png');
  const table = page.getByRole('table', { name: 'Page 1 table 1', exact: true });
  await expect(table).toBeVisible({ timeout: 30000 });
  await expect(table.locator('td[colspan="3"]')).toHaveCount(1);
  await expect(table.locator('td[rowspan="2"]')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Page 1 table 1 row 3 column 1', exact: true })).toHaveValue('1');
  await expect(page.getByRole('textbox', { name: 'Page 1 table 1 row 4 column 1', exact: true })).toHaveValue('2');
  await expect(page.getByRole('textbox', { name: 'Page 1 table 1 row 5 column 1', exact: true })).toHaveValue('3');
  const cell = page.getByRole('textbox', { name: 'Page 1 table 1 row 5 column 2', exact: true });
  await expect(cell).toContainText('Outdoor');
  await cell.fill('Outdoor cable — corrected');
  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const csv = await readFile(await (await csvDownload).path(), 'utf8');
  expect(csv).toContain('Outdoor cable — corrected');
  expect(csv).toContain('Cable specifications');
  const jsonDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  const data = JSON.parse(await readFile(await (await jsonDownload).path(), 'utf8'));
  expect(data.edited).toBe(true);
  expect(data.page_results[0].tables[0].cells.some(item => item.text === 'Outdoor cable — corrected')).toBe(true);
  expect(data.page_results[0].preprocessing).toContain('page-perspective');
  await page.screenshot({ path: 'test-results/letter-table-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
