const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const yaml = require('../desktop/node_modules/js-yaml');
const { updateRepository } = require('./release-config.cjs');

async function digest(filename, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest(encoding);
}

async function verifyRelease(directory, version, repository) {
  assert.ok(repository, 'A GitHub update repository is required.');
  const filename = `OCR-Nexus-Setup-${version}-x64.exe`;
  const executable = path.join(directory, filename);
  const metadata = yaml.load(fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8'));
  assert.equal(metadata.version, version, 'Update metadata version must match the installer.');
  assert.equal(metadata.files.length, 1, 'Expected exactly one Windows installer.');
  assert.equal(metadata.files[0].url, filename, 'Unexpected installer URL.');
  assert.equal(metadata.files[0].size, fs.statSync(executable).size, 'Installer size mismatch.');
  const sha512 = await digest(executable, 'sha512', 'base64');
  assert.equal(metadata.files[0].sha512, sha512, 'Installer SHA-512 mismatch.');
  if (metadata.sha512) assert.equal(metadata.sha512, sha512);
  if (metadata.path) assert.equal(metadata.path, filename);
  const sha256 = await digest(executable, 'sha256', 'hex');
  assert.equal(fs.readFileSync(`${executable}.sha256`, 'utf8').trim(), `${sha256}  ${filename}`);
  assert.ok(fs.statSync(`${executable}.blockmap`).size > 0, 'Missing differential update metadata.');
  const feed = yaml.load(fs.readFileSync(path.join(directory, 'win-unpacked/resources/app-update.yml'), 'utf8'));
  assert.equal(feed.provider, 'github');
  assert.equal(feed.owner, repository.owner);
  assert.equal(feed.repo, repository.repo);
  assert.equal(feed.private, false);
  assert.ok(!('token' in feed) && !('requestHeaders' in feed), 'Credentials must never be embedded in the update feed.');
  console.log(`Verified ${filename}, update hashes, and public GitHub feed.`);
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const pkg = require('../desktop/package.json');
  verifyRelease(path.join(root, 'release'), pkg.version, updateRepository()).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { verifyRelease };
