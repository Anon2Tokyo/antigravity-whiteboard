import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const pluginDir = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity-whiteboard');

fs.mkdirSync(path.join(pluginDir, 'assets'), { recursive: true });
fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
fs.mkdirSync(path.join(pluginDir, 'skills', 'diagram-design'), { recursive: true });

const filesToCopy = [
  'plugin.json',
  'mcp_config.json',
  'README.md',
  'DESIGN.md',
  'assets/logo.svg',
  'skills/diagram-design/SKILL.md',
  'dist/server.mjs',
  'dist/index.html',
];

for (const rel of filesToCopy) {
  const src = path.join(rootDir, rel);
  const dst = path.join(pluginDir, rel);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  }
}

console.log(`Installed Antigravity plugin to: ${pluginDir}`);
