'use strict';
// Zero-dependency checks: JavaScript syntax, basic whitespace rules, and that the manifest, package.json and
// server code agree on version and tools. Runs the PHP linter on the SEO Bridge plugin when php is installed.
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const problems = [];
const rel = file => path.relative(root, file).replace(/\\/g, '/');

function files(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

const jsFiles = ['server', 'scripts', 'test'].flatMap(d => files(path.join(root, d), '.js'));
for (const file of jsFiles) {
  const check = spawnSync(process.execPath, ['--check', file], {encoding: 'utf8'});
  if (check.status !== 0) problems.push(rel(file) + ': syntax error\n' + check.stderr.trim());
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/[ \t]+$/.test(line)) problems.push(rel(file) + ':' + (i + 1) + ': trailing whitespace');
    if (line.includes('\t')) problems.push(rel(file) + ':' + (i + 1) + ': tab character');
  });
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const {tools, VERSION} = require('../server/service.js');
if (manifest.version !== VERSION || pkg.version !== VERSION) {
  problems.push('Version mismatch: manifest ' + manifest.version + ', package.json ' + pkg.version + ', server ' + VERSION);
}
const declared = manifest.tools.map(t => t.name).join(', ');
const served = tools.map(t => t.name).join(', ');
if (declared !== served) problems.push('manifest.json tools differ from server tools:\n  manifest: ' + declared + '\n  server:   ' + served);
const envText = JSON.stringify(manifest.server.mcp_config.env);
for (const key of Object.keys(manifest.user_config)) {
  if (!envText.includes('${user_config.' + key + '}')) problems.push('user_config.' + key + ' is not passed to the server in mcp_config.env');
}

const plugin = path.join(root, 'wordpress-plugin', 'mkt-wp-publisher-seo-bridge', 'mkt-wp-publisher-seo-bridge.php');
const php = spawnSync('php', ['-l', plugin], {encoding: 'utf8'});
if (php.error) console.log('php not found: skipped the PHP syntax check of the SEO Bridge plugin.');
else if (php.status !== 0) problems.push(rel(plugin) + ': ' + (php.stdout + php.stderr).trim());

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('lint ok: ' + jsFiles.length + ' JavaScript files, version ' + VERSION + ', ' + tools.length + ' tools.');
