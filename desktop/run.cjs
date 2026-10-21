const { spawn } = require('node:child_process');
const env = { ...process.env };
// Some editor hosts set this for their own Electron process.
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [__dirname], { env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
