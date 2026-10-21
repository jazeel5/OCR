const fs = require('node:fs');
const path = require('node:path');
const { createPrivateKey, randomUUID } = require('node:crypto');
const dotenv = require('dotenv');

const KEYS = ['OCR_PROVIDER', 'TESSERACT_LANG', 'GOOGLE_LANGUAGE_HINTS',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_QUOTA_PROJECT'];

function readSettings(userData) {
  fs.mkdirSync(userData, { recursive: true });
  const filename = path.join(userData, 'settings.env');
  try {
    fs.writeFileSync(filename, '# Managed by OCR settings in the application.\nOCR_PROVIDER=google\nTESSERACT_LANG=eng\nGOOGLE_LANGUAGE_HINTS=\n', { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const parsed = dotenv.parse(fs.readFileSync(filename));
  return Object.fromEntries(KEYS.filter(key => parsed[key] !== undefined).map(key => [key, parsed[key]]));
}

function readCredential(filename) {
  try {
    if (fs.statSync(filename).size > 65536) throw new Error();
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (value.type !== 'service_account' || !/^[a-z0-9][a-z0-9:.-]+$/.test(value.project_id || '')
      || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(value.client_email || '')
      || value.token_uri !== 'https://oauth2.googleapis.com/token'
      || createPrivateKey(value.private_key).asymmetricKeyType !== 'rsa') throw new Error();
    // Only the service-account fields used by Google authentication are kept.
    return Object.fromEntries(['type', 'project_id', 'private_key_id', 'private_key', 'client_email', 'client_id', 'token_uri']
      .filter(key => typeof value[key] === 'string').map(key => [key, value[key]]));
  } catch { throw new Error('Choose a valid Google service-account JSON key downloaded from Google Cloud.'); }
}

function publicSettings(userData) {
  const settings = readSettings(userData);
  let credential;
  try { credential = readCredential(settings.GOOGLE_APPLICATION_CREDENTIALS); } catch { /* Setup may be incomplete. */ }
  return { provider: settings.OCR_PROVIDER || 'google', localLanguage: settings.TESSERACT_LANG || 'eng',
    cloudLanguage: settings.GOOGLE_LANGUAGE_HINTS || '', credentialConfigured: !!credential,
    projectId: credential?.project_id || '' };
}

function atomicWrite(filename, contents) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, filename); }
  finally { fs.rmSync(temporary, { force: true }); }
}

function saveSettings(userData, input, credential) {
  if (!input || !['google', 'tesseract'].includes(input.provider)
    || !['eng', 'eng+kan', 'kan'].includes(input.localLanguage)
    || !['', 'en', 'kn', 'en,kn'].includes(input.cloudLanguage)) throw new Error('Choose one of the available OCR and language options.');
  const settings = readSettings(userData);
  if (input.provider === 'google' && !credential) readCredential(settings.GOOGLE_APPLICATION_CREDENTIALS);
  if (credential && input.provider === 'google') {
    const filename = path.join(userData, `google-credentials-${randomUUID()}.json`);
    atomicWrite(filename, `${JSON.stringify(credential)}\n`);
    settings.GOOGLE_APPLICATION_CREDENTIALS = filename.replaceAll('\\', '/');
    settings.GOOGLE_CLOUD_PROJECT = credential.project_id;
    settings.GOOGLE_CLOUD_QUOTA_PROJECT = credential.project_id;
  }
  Object.assign(settings, { OCR_PROVIDER: input.provider, TESSERACT_LANG: input.localLanguage,
    GOOGLE_LANGUAGE_HINTS: input.cloudLanguage });
  const lines = KEYS.filter(key => settings[key] !== undefined).map(key => {
    // dotenv values must not be able to inject extra settings.
    const value = String(settings[key]).replaceAll('\\', '/');
    if (/[\r\n"]/.test(value)) throw new Error('An existing setting contains an unsupported character.');
    return `${key}="${value}"`;
  });
  atomicWrite(path.join(userData, 'settings.env'), `# Managed by OCR settings in the application.\n${lines.join('\n')}\n`);
  return publicSettings(userData);
}

module.exports = { readSettings, readCredential, publicSettings, saveSettings };
