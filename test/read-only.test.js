'use strict';
// Read-only websites: every tool that is not read-only is refused before any request; reading tools work as before.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {makeService, tools} = require('../server/service.js');
const {sites, mock, slot} = require('./helpers.js');

const readOnlyEnv = {WP_SITES_JSON: JSON.stringify([{...sites[0], read_only: true}, sites[1]])};

test('read-only: every writing tool is refused on that website without a single request', async () => {
  const writers = tools.filter(t => !t.annotations.readOnlyHint && t.name !== 'list_sites');
  assert.equal(writers.length, 17, 'every writing tool is covered');
  for (const t of writers) {
    const m = mock([]);
    // Arguments only need to pass the schema: required fields with the right types.
    const args = {site_id: 'site-a'};
    for (const key of t.inputSchema.required) {
      const s = t.inputSchema.properties[key];
      if (key === 'site_id') continue;
      if (s.type === 'integer') args[key] = 5;
      else if (s.type === 'boolean') args[key] = true;
      else if (s.type === 'array') args[key] = [{block: '0', replace_text: {find: 'a', with: 'b'}}];
      else if (s.enum) args[key] = s.enum[0];
      else if (s.pattern) args[key] = ['post', '10', '0123456789abcdef'].find(v => new RegExp(s.pattern).test(v));
      else args[key] = 'Text';
    }
    await assert.rejects(makeService(readOnlyEnv, m.f)(t.name, args), /site-a is set to read-only.*Nothing was sent to WordPress/, t.name);
    assert.equal(m.calls.length, 0, t.name + ' made no request');
  }
});

test('read-only: reading tools still work there, and other websites are not affected', async () => {
  const m = mock([{id: 9, name: 'Ed', slug: 'ed', roles: ['editor'], capabilities: {edit_posts: true}}]);
  const r = await makeService(readOnlyEnv, m.f)('test_connection', {site_id: 'site-a'});
  assert.equal(r.data.user_id, 9);
  const draft = mock([[], {id: 3, status: 'draft', title: {raw: 'T'}, slug: 't'}]);
  const created = await makeService(readOnlyEnv, draft.f)('create_draft', {site_id: 'site-b', title: 'T', content: 'C', slug: 't'});
  assert.equal(created.data.post_id, 3);
  assert.equal(draft.calls[1].o.method, 'POST');
});

test('read-only: list_sites shows the flag; Website 1-5 settings and JSON profiles both set it', async () => {
  const listed = await makeService(readOnlyEnv)('list_sites');
  assert.equal(listed.sites[0].read_only, true);
  assert(!('read_only' in listed.sites[1]));
  const slots = {...slot(1, 'C:/A', {READ_ONLY: 'true'}), ...slot(2, 'C:/B', {READ_ONLY: 'false'}), ...slot(3, 'C:/C')};
  const r = await makeService(slots)('list_sites');
  assert.deepEqual(r.sites.map(s => !!s.read_only), [true, false, false]);
  await assert.rejects(makeService(slots, mock([]).f)('update_draft', {site_id: 'website-1', post_id: 1, title: 'X'}), /website-1 is set to read-only/);
});

test('read-only: bad values are rejected; unset placeholders and the manifest are wired up', async () => {
  await assert.rejects(makeService({...slot(1, 'C:/A', {READ_ONLY: 'yes'})})('list_sites'), /Website 1 read-only setting must be true or false/);
  await assert.rejects(makeService({WP_SITES_JSON: JSON.stringify([{...sites[0], read_only: 'true'}])})('list_sites'), /Site site-a: read_only must be true or false/);
  const placeholder = await makeService({...slot(1, 'C:/A', {READ_ONLY: '${user_config.website_1_read_only}'})})('list_sites');
  assert(!('read_only' in placeholder.sites[0]));
  // A read-only flag on a disabled website with JSON profiles configured must not count as "website details".
  const json = await makeService({WP_SITES_JSON: JSON.stringify(sites), WP_SITE_2_READ_ONLY: 'false'})('list_sites');
  assert.equal(json.sites.length, 2);
  const m = JSON.parse(await fs.readFile(path.join(__dirname, '../manifest.json'), 'utf8'));
  for (let n = 1; n <= 5; n++) {
    assert.equal(m.user_config['website_' + n + '_read_only'].type, 'boolean');
    assert.equal(m.user_config['website_' + n + '_read_only'].default, false);
    assert.equal(m.server.mcp_config.env['WP_SITE_' + n + '_READ_ONLY'], '${user_config.website_' + n + '_read_only}');
  }
});
