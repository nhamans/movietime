#!/usr/bin/env node
/**
 * Cross-platform launcher & setup script for MovieTime (Open Source).
 * Allows any user who clones the repo to simply run:
 *   npm install
 *   npm start
 */

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';
const rootDir = __dirname;
const backendDir = path.join(rootDir, 'backend');
const frontendDir = path.join(rootDir, 'frontend');

const mode = process.argv[2] || 'start'; // 'setup' | 'start' | 'build'

function findPython() {
  const candidates = isWin
    ? [
        'python',
        'py',
        path.join(process.env.LOCALAPPDATA || '', 'Python', 'bin', 'python.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
      ]
    : ['python3', 'python'];

  for (const cmd of candidates) {
    if (!cmd) continue;
    try {
      const res = spawnSync(cmd, ['--version'], { stdio: 'pipe', encoding: 'utf-8' });
      if (res.status === 0 && (res.stdout.includes('Python') || res.stderr.includes('Python'))) {
        return cmd;
      }
    } catch {}
  }
  return isWin ? 'python' : 'python3';
}

function getVenvPython() {
  return isWin
    ? path.join(backendDir, '.venv', 'Scripts', 'python.exe')
    : path.join(backendDir, '.venv', 'bin', 'python');
}

function runCommand(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: isWin,
  });
  if (res.status !== 0) {
    process.exit(res.status || 1);
  }
}

function ensureBackendSetup() {
  const venvPython = getVenvPython();
  if (!fs.existsSync(venvPython)) {
    const sysPython = findPython();
    console.log(`[MovieTime] Creating Python virtual environment using ${sysPython}...`);
    runCommand(sysPython, ['-m', 'venv', '.venv'], backendDir);
    console.log('[MovieTime] Installing Python backend dependencies...');
    runCommand(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt'], backendDir);
  }
}

function ensureFrontendBuild(forceInstall = false) {
  const nodeModules = path.join(frontendDir, 'node_modules');
  const distIndex = path.join(frontendDir, 'dist', 'index.html');
  const npmCmd = isWin ? 'npm.cmd' : 'npm';

  if (forceInstall || !fs.existsSync(nodeModules)) {
    console.log('[MovieTime] Installing frontend packages...');
    runCommand(npmCmd, ['install'], frontendDir);
  }
  if (forceInstall || !fs.existsSync(distIndex)) {
    console.log('[MovieTime] Building frontend UI bundle...');
    runCommand(npmCmd, ['run', 'build'], frontendDir);
  }
}

if (mode === 'setup') {
  ensureBackendSetup();
  ensureFrontendBuild(true);
  console.log('\n[MovieTime] Setup complete! Run `npm start` to launch the app.');
} else if (mode === 'build') {
  ensureFrontendBuild(false);
} else {
  ensureBackendSetup();
  ensureFrontendBuild(false);

  const venvPython = getVenvPython();
  console.log('\n=====================================================');
  console.log('  MovieTime — Self-Hosted SMB Local Media Streamer');
  console.log('  Web UI & API running at: http://localhost:8000');
  console.log('  Press Ctrl+C to stop');
  console.log('=====================================================\n');

  const server = spawn(
    venvPython,
    ['-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', '8000'],
    {
      cwd: backendDir,
      stdio: 'inherit',
      shell: false,
    }
  );

  server.on('close', (code) => {
    process.exit(code || 0);
  });
}
