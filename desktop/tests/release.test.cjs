const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { updateRepository, releaseVersion, stampRelease } = require('../../scripts/release-config.cjs');
const { verifyRelease } = require('../../scripts/verify-release.cjs');

test('GitHub automatically supplies a public feed without shipping a token', () => {
  const feed = updateRepository({ GITHUB_REPOSITORY: 'person/ocr-nexus', GH_TOKEN: 'must-not-ship' });
  assert.deepEqual(feed, { provider: 'github', owner: 'person', repo: 'ocr-nexus', releaseType: 'release', private: false });
  assert.equal(updateRepository({}), null);
  for (const value of ['https://github.com/a/b', 'a/b\nsecret', '../repo', 'a/b/c']) {
    assert.throws(() => updateRepository({ GITHUB_REPOSITORY: value }));
  }
});

test('each workflow run increases the version and respects Windows version limits', () => {
  assert.equal(releaseVersion('2.2.0', '1'), '2.2.1');
  assert.equal(releaseVersion('2.2.0', '2'), '2.2.2');
  assert.equal(releaseVersion('2.3.0', '456'), '2.3.456');
  for (const n of ['0', '-1', 'NaN', '1.5', '65536']) assert.throws(() => releaseVersion('2.2.0', n));
  assert.throws(() => releaseVersion('2.2.1', '2'));
});

test('release stamping keeps the package and npm lock aligned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-release-'));
  try {
    fs.mkdirSync(path.join(root, 'desktop'));
    fs.writeFileSync(path.join(root, 'desktop/package.json'), JSON.stringify({ version: '2.2.0' }));
    fs.writeFileSync(path.join(root, 'desktop/package-lock.json'), JSON.stringify({ version: '2.2.0', packages: { '': { version: '2.2.0' } } }));
    const output = path.join(root, 'output');
    stampRelease(root, { GITHUB_REPOSITORY: 'person/ocr', GITHUB_RUN_NUMBER: '12', GITHUB_OUTPUT: output });
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'))).version, '2.2.12');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'desktop/package-lock.json'))).packages[''].version, '2.2.12');
    assert.equal(fs.readFileSync(output, 'utf8'), 'version=2.2.12\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('release verification rejects a mismatched installer or wrong update repository', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-release-hashes-'));
  const repository = updateRepository({ GITHUB_REPOSITORY: 'person/ocr' });
  try {
    const bytes = Buffer.from('test installer bytes');
    const filename = 'OCR-Nexus-Setup-2.2.1-x64.exe';
    const sha512 = createHash('sha512').update(bytes).digest('base64');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(root, filename), bytes);
    fs.writeFileSync(path.join(root, `${filename}.blockmap`), 'blockmap');
    fs.writeFileSync(path.join(root, `${filename}.sha256`), `${sha256}  ${filename}\n`);
    fs.writeFileSync(path.join(root, 'latest.yml'), JSON.stringify({ version: '2.2.1', files: [{ url: filename, size: bytes.length, sha512 }] }));
    fs.mkdirSync(path.join(root, 'win-unpacked/resources'), { recursive: true });
    fs.writeFileSync(path.join(root, 'win-unpacked/resources/app-update.yml'), JSON.stringify(repository));
    await verifyRelease(root, '2.2.1', repository);
    await assert.rejects(verifyRelease(root, '2.2.1', { ...repository, repo: 'wrong' }));
    fs.writeFileSync(path.join(root, filename), Buffer.alloc(bytes.length));
    await assert.rejects(verifyRelease(root, '2.2.1', repository), /SHA-512/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
