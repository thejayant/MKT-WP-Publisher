'use strict';
// Runs every test/*.test.js file with node:test. A script instead of a glob, because Node 18/20 do not expand
// globs and Node 22's default discovery would also load test/helpers.js as a test file.
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(dir, f));
const run = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {stdio: 'inherit'});
process.exit(run.status ?? 1);
