'use strict';
// Runs the SEO Bridge PHP plugin through test/php/bridge-harness.php, one fresh PHP process per scenario.
// Uses MKT_PHP (path to php) or php on PATH; skipped when neither exists.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const plugin = path.join(root, 'wordpress-plugin', 'mkt-wp-publisher-seo-bridge', 'mkt-wp-publisher-seo-bridge.php');
const harness = path.join(__dirname, 'php', 'bridge-harness.php');
const php = process.env.MKT_PHP || 'php';
const probe = spawnSync(php, ['-r', 'echo PHP_VERSION;'], {encoding: 'utf8'});
const skip = probe.status === 0 ? false : 'PHP not found (set MKT_PHP or put php on PATH)';

const SCENARIOS = [
  'loads-twice',
  'no-seo-plugin',
  'yoast',
  'rank-math-with-hostile-autoloader',
  'both-plugins',
  'lenient-input',
  'other-plugins-filters',
  'no-permission',
  'storage-failure',
  'custom-site-without-pages',
  'admin-page',
  'all-post-types-and-taxonomies',
  'term-yoast',
  'term-rank-math',
  'term-permissions-and-conflicts',
  'fields-acf-read',
  'fields-acf-write',
  'fields-meta',
  'fields-terms',
  'fields-storage-failure',
  'fields-admin-meta-keys',
  'seopress',
  'aioseo',
  'aioseo-missing-table',
  'seo-plugin-precedence',
  'page-builder',
];

test('SEO Bridge plugin: PHP syntax', {skip}, () => {
  const lint = spawnSync(php, ['-l', plugin], {encoding: 'utf8'});
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
});

for (const scenario of SCENARIOS) {
  test('SEO Bridge plugin (PHP ' + (probe.stdout || '?') + '): ' + scenario, {skip}, () => {
    const run = spawnSync(php, [harness, scenario, plugin], {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, new RegExp('^OK ' + scenario + '$', 'm'));
  });
}

module.exports = {SCENARIOS};
