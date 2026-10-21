import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.OCR_PYTHON || path.join(root, 'ocr-service', 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const vite = path.join(root, 'frontend/node_modules/vite/bin/vite.js');
if (!existsSync(python) || !existsSync(vite)) {
  console.error('Install frontend/backend packages and the Python virtual environment first. See README.md.');
  process.exit(1);
}
const commands = [
  [python, ['main.py'], 'ocr-service'],
  [process.execPath, ['server.js'], 'backend'],
  [process.execPath, [vite, '--host', '127.0.0.1', '--port', '5173', '--strictPort'], 'frontend'],
];
let stopping = false;
let exitCode = 0;
const children = [];
const running = new Set();
const grouped = process.platform !== 'win32';
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children) {
    if (!child.pid) continue;
    try { grouped ? process.kill(-child.pid, 'SIGTERM') : child.kill('SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
  }
  if (!running.size) process.exit(exitCode);
}
for (const [command, args, directory] of commands) {
  const child = spawn(command, args, { cwd: path.join(root, directory), stdio: 'inherit', detached: grouped });
  children.push(child);
  running.add(child);
  child.on('error', error => { console.error(`${directory}: ${error.message}`); stop(1); });
  child.on('close', code => {
    running.delete(child);
    if (!stopping) stop(code || 1);
    if (!running.size) process.exit(exitCode);
  });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log('Starting OCR Nexus. Open http://127.0.0.1:5173 once Vite is ready. Press Ctrl+C to stop all services.');
