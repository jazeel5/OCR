const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const { publicSettings, readSettings, readCredential, saveSettings } = require('../settings.cjs');

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const credential = { type: 'service_account', project_id: 'ocr-test-project', private_key: privateKey,
  private_key_id: 'test-only', client_email: 'ocr@ocr-test-project.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token' };
const google = { provider: 'google', localLanguage: 'eng', cloudLanguage: '' };

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('fresh settings offer Google setup and reject activation without credentials', t => {
  const directory = folder(t);
  assert.deepEqual(publicSettings(directory), { ...google, credentialConfigured: false, projectId: '' });
  assert.throws(() => saveSettings(directory, google), /valid Google service-account/);
});

test('credentials remain in the user folder and never appear in the renderer settings', t => {
  const directory = folder(t);
  const keyFile = path.join(directory, 'selected-key.json');
  fs.writeFileSync(keyFile, JSON.stringify(credential));
  const result = saveSettings(directory, { ...google, cloudLanguage: 'en,kn' }, readCredential(keyFile));
  assert.equal(result.projectId, credential.project_id);
  assert.equal(result.credentialConfigured, true);
  assert.equal(result.cloudLanguage, 'en,kn');
  assert.ok(!JSON.stringify(result).includes('PRIVATE KEY'));
  assert.ok(!('GOOGLE_APPLICATION_CREDENTIALS' in result));
  const config = readSettings(directory);
  assert.equal(path.dirname(config.GOOGLE_APPLICATION_CREDENTIALS), directory);
  assert.equal(readCredential(config.GOOGLE_APPLICATION_CREDENTIALS).private_key, privateKey);
  assert.ok(!fs.readFileSync(path.join(directory, 'settings.env'), 'utf8').includes('PRIVATE KEY'));
  assert.equal(publicSettings(directory).provider, 'google');
});

test('rejects malformed keys and arbitrary authentication endpoints', t => {
  const directory = folder(t);
  const keyFile = path.join(directory, 'key.json');
  for (const value of [{ ...credential, private_key: 'invalid' }, { ...credential, token_uri: 'https://example.com/token' },
    { type: 'external_account' }, { ...credential, project_id: 'bad\nOCR_PROVIDER=x' }]) {
    fs.writeFileSync(keyFile, JSON.stringify(value));
    assert.throws(() => readCredential(keyFile), /valid Google service-account/);
  }
});

test('preserves existing choices, supports offline mode, and rejects settings injection', t => {
  const directory = folder(t);
  fs.writeFileSync(path.join(directory, 'settings.env'), 'OCR_PROVIDER=tesseract\nTESSERACT_LANG=eng+kan\n');
  assert.equal(publicSettings(directory).provider, 'tesseract');
  assert.equal(publicSettings(directory).localLanguage, 'eng+kan');
  saveSettings(directory, { ...google, provider: 'tesseract', localLanguage: 'kan' });
  const before = fs.readFileSync(path.join(directory, 'settings.env'), 'utf8');
  assert.throws(() => saveSettings(directory, { ...google, provider: 'google\nX=1' }), /available OCR/);
  assert.equal(fs.readFileSync(path.join(directory, 'settings.env'), 'utf8'), before);
});
