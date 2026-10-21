const fs = require('node:fs');
const path = require('node:path');

function updateRepository(env = process.env) {
  const value = (env.OCR_UPDATE_REPOSITORY || env.GITHUB_REPOSITORY || '').trim();
  if (!value) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('Update repository must be a GitHub owner/repository name.');
  }
  const [owner, repo] = value.split('/');
  return { provider: 'github', owner, repo, releaseType: 'release', private: false };
}

function releaseVersion(base, runNumber) {
  const parts = /^(\d+)\.(\d+)\.0$/.exec(base);
  const sequence = Number(runNumber);
  if (!parts || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 65535 ||
      Number(parts[1]) > 65535 || Number(parts[2]) > 65535) {
    throw new Error('Use a major.minor.0 base version and a GitHub run number from 1 to 65535.');
  }
  return `${parts[1]}.${parts[2]}.${sequence}`;
}

function stampRelease(root, env = process.env) {
  const repository = updateRepository(env);
  if (!repository) throw new Error('GITHUB_REPOSITORY is required for a release build.');
  const packageFile = path.join(root, 'desktop/package.json');
  const lockFile = path.join(root, 'desktop/package-lock.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const version = releaseVersion(pkg.version, env.GITHUB_RUN_NUMBER);
  pkg.version = lock.version = lock.packages[''].version = version;
  fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `version=${version}\n`);
  console.log(`Release version: ${version} (${repository.owner}/${repository.repo})`);
  return version;
}

if (require.main === module) stampRelease(path.resolve(__dirname, '..'));
module.exports = { updateRepository, releaseVersion, stampRelease };
