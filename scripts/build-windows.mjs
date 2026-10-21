import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonVenv = path.join(root, 'ocr-service', 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.PYTHON || (existsSync(pythonVenv) ? pythonVenv : process.platform === 'win32' ? 'python' : 'python3');
function run(command, args, cwd = root, env = {}) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(process.execPath, [path.join(root, 'frontend/node_modules/vite/bin/vite.js'), 'build'], path.join(root, 'frontend'), { VITE_API_BASE_URL: '' });
run(python, [path.join(root, 'scripts/vendor-windows.py')]);
run(process.execPath, [path.join(root, 'desktop/node_modules/electron-builder/cli.js'), '--config', 'electron-builder.cjs', '--win', 'nsis', '--x64', '--publish', 'never'], path.join(root, 'desktop'));
const { version } = JSON.parse(readFileSync(path.join(root, 'desktop/package.json')));
const name = `OCR-Nexus-Setup-${version}-x64.exe`;
const installer = path.join(root, 'release', name);
const hash = createHash('sha256').update(readFileSync(installer)).digest('hex');
writeFileSync(`${installer}.sha256`, `${hash}  ${name}\n`);
writeFileSync(path.join(root, 'release', 'INSTALL-WINDOWS.txt'), `OCR Nexus ${version} — Windows 10/11, 64-bit (x64)\n\n1. Copy ${name} to your Windows PC.\n2. Double-click it and follow the setup wizard.\n3. Open OCR Nexus from the Start menu or desktop shortcut.\n\nThe installer includes Python, Tesseract, English/Kannada models, and all\napplication services. No Node.js, Python, or Tesseract installation is needed.\nLocal OCR works offline. Extracted text and table cells can be edited and\nexported as TXT, CSV, and JSON.\n\nOpen OCR settings in the app header. Choose Google Cloud Vision, select\nyour service-account JSON key, then Save and restart. Google requires\ninternet, Cloud Vision API access, and billing. For use without Google,\nchoose Local OCR (offline). Existing installations keep their provider.\n\nGitHub release builds check for updates at startup and every 15 minutes.\nUse Help > Check for updates to check manually. Updates download and install\nonly after you choose to proceed. Export edits before restarting. Install the\nfirst GitHub release once to enable updates; the old 2.1.0 build has no updater.\n\nChoose English, Kannada, or both in OCR settings. Google also supports\nautomatic language detection. Credentials stay on your PC and are never\nincluded in this installer. See README.md for Google Cloud setup steps.\n\nThis personal build is unsigned. Windows may show an unknown-publisher or\nSmartScreen warning. Verify the file is the one built for this project.\nSHA-256: ${hash}\n\nUse File > Open OCR log for diagnostics. Settings are normally stored in\n%APPDATA%/OCR Nexus. Uninstall using Windows Settings > Apps.\n\nBuild platform: ${process.platform}. For native Windows verification, run the\nWindows updates workflow included with the project; it tests the packaged\napp and publishes an update after each successful default-branch push.\n`);
console.log(`\nWindows installer: ${installer}\nSHA-256: ${hash}`);
