'use strict';
// Build release files into the output folder (default: the folder above the project):
//   mkt-wp-publisher-<version>.mcpb   Claude Desktop extension (uses the official @anthropic-ai/mcpb CLI via npx)
//   mkt-wp-publisher-seo-bridge.zip   WordPress plugin, installable via Plugins > Add New > Upload Plugin
// Usage: npm run pack [-- --out <folder>] [-- --plugin-only]
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {createZip} = require('./zip.js');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = path.resolve(outIndex >= 0 ? args[outIndex + 1] : path.join(root, '..'));
const pluginOnly = args.includes('--plugin-only');
const {version} = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function run(command, commandArgs, {shell = false} = {}) {
  const result = spawnSync(command, commandArgs, {cwd: root, stdio: 'inherit', shell});
  if (result.status !== 0) process.exit(result.status ?? 1);
}

fs.mkdirSync(outDir, {recursive: true});
run(process.execPath, [path.join(__dirname, 'lint.js')]);
run(process.execPath, [path.join(__dirname, 'test.js')]);

if (!pluginOnly) {
  const bundle = path.join(outDir, 'mkt-wp-publisher-' + version + '.mcpb');
  // npx is a .cmd shim on Windows, which needs a shell; there the path is quoted so folders with spaces survive.
  const windows = process.platform === 'win32';
  run('npx', ['-y', '@anthropic-ai/mcpb', 'pack', '.', windows ? '"' + bundle + '"' : bundle], {shell: windows});
}

const pluginDir = path.join(root, 'wordpress-plugin', 'mkt-wp-publisher-seo-bridge');
const entries = [{name: 'mkt-wp-publisher-seo-bridge/'}];
for (const name of fs.readdirSync(pluginDir).sort()) {
  entries.push({name: 'mkt-wp-publisher-seo-bridge/' + name, data: fs.readFileSync(path.join(pluginDir, name))});
}
const zipPath = path.join(outDir, 'mkt-wp-publisher-seo-bridge.zip');
fs.writeFileSync(zipPath, createZip(entries));
console.log('Wrote ' + zipPath);
