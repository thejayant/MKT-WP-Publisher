'use strict';
// queue_editor_changes / list_editor_changes / cancel_editor_change: changes that wait in the block editor (SEO Bridge 1.5).
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {makeService} = require('../server/service.js');
const {env} = require('./helpers.js');

const content = '<!-- wp:heading --><h2>Metal Buildings Florida</h2><!-- /wp:heading -->\n<!-- wp:paragraph --><p>We serve all 67 Florida counties.</p><!-- /wp:paragraph -->';
const post = (over = {}) => ({id: 1941, type: 'page', status: 'publish', title: {raw: 'Florida'}, modified_gmt: '2026-10-20T10:00:00', content: {raw: content}, mkt_builder: null, ...over});
const QUEUE = 'https://a.example/wp-json/mkt-seo-bridge/v1/editor-queue/1941';

/** A fake WordPress: answers by method and URL, records every call. */
function site(routes) {
  const calls = [];
  const f = async (u, o) => {
    calls.push({u, o, body: o.body ? JSON.parse(o.body) : undefined});
    const key = o.method + ' ' + u;
    const answer = routes[key];
    if (answer === undefined) throw new Error('Unexpected request ' + key);
    const value = typeof answer === 'function' ? answer(calls.at(-1)) : answer;
    if (value && value.__status) return {ok: false, status: value.__status, json: async () => value.body};
    return {ok: true, json: async () => value};
  };
  return {calls, f};
}
const GET_POST = 'GET https://a.example/wp-json/wp/v2/pages/1941?context=edit';
const noRoute = {__status: 404, body: {code: 'rest_no_route', message: 'No route was found matching the URL and request method.'}};
const call = (s, name, args) => makeService(env, s.f)(name, {site_id: 'site-a', post_type: 'page', post_id: 1941, ...args});

test('queue_editor_changes: block edits are prepared from the saved content and queued, nothing else is written', async () => {
  const s = site({
    [GET_POST]: post(),
    ['GET ' + QUEUE]: {version: '1.5.0', post_id: 1941, items: []},
    ['POST ' + QUEUE]: req => ({id: '0123456789abcdef', status: 'pending', label: req.body.label, summary: req.body.summary}),
  });
  const r = await call(s, 'queue_editor_changes', {changes: [{block: '1', replace_text: {find: 'all 67 Florida counties', with: 'every county in Florida'}}], label: 'County wording', expected_modified_gmt: '2026-10-20T10:00:00Z'});
  assert.deepEqual(s.calls.map(c => c.o.method), ['GET', 'GET', 'POST']);
  const sent = s.calls[2].body;
  assert.equal(sent.base_modified_gmt, '2026-10-20T10:00:00');
  assert.equal(sent.label, 'County wording');
  assert.equal(sent.content, content.replace('all 67 Florida counties', 'every county in Florida'));
  assert.equal(sent.summary.length, 1);
  assert.match(sent.summary[0].after, /every county in Florida/);
  assert(!s.calls.some(c => c.u.includes('/wp/v2/') && c.o.method === 'POST'), 'the post itself is never written');
  assert.equal(r.data.batch_id, '0123456789abcdef');
  assert.equal(r.data.queue_status, 'pending');
  assert.equal(r.data.edit_url, 'https://a.example/wp-admin/post.php?post=1941&action=edit');
  assert.match(r.data.next, /Nothing is saved yet.*Apply and Dismiss/);
});

test('queue_editor_changes: whole content, Markdown, and a default label', async () => {
  const s = site({
    [GET_POST]: post({status: 'draft'}),
    ['GET ' + QUEUE]: {version: '1.5.0', items: []},
    ['POST ' + QUEUE]: req => ({id: 'aaaaaaaaaaaaaaaa', status: 'pending', label: req.body.label}),
  });
  await call(s, 'queue_editor_changes', {content: '# New page\n\nHello', content_format: 'markdown'});
  assert.match(s.calls[2].body.content, /<h1>New page<\/h1>/);
  assert.equal(s.calls[2].body.label, 'Changes from Claude');
  assert.match(s.calls[2].body.summary[0].after, /whole new content/);
});

test('queue_editor_changes: refused before anything is queued', async () => {
  const cases = [
    [{}, {content: 'x', changes: [{replace_text: {find: 'a', with: 'b'}}]}, /either changes .* or content/],
    [{}, {content_format: 'markdown', changes: [{replace_text: {find: 'a', with: 'b'}}]}, /content_format needs content/],
    [{mkt_builder: {id: 'elementor', name: 'Elementor', storage: 'meta'}}, {content: '<p>x</p>'}, /built with Elementor.*update_elementor_layout/],
    [{mkt_builder: {id: 'divi', name: 'Divi', storage: 'content'}}, {content: '<p>x</p>'}, /built with Divi, so it is not edited in the block editor/],
    [{status: 'trash'}, {content: '<p>x</p>'}, /this one is trash/],
    [{}, {content: content}, /leave the content exactly as it is/],
    [{}, {content: '<p>x</p>', expected_modified_gmt: '2026-10-19T00:00:00'}, /changed since you read it.*nothing was queued/],
    [{}, {changes: [{block: '9', replace_text: {find: 'a', with: 'b'}}]}, /there is no block 9/],
  ];
  for (const [over, args, pattern] of cases) {
    const s = site({[GET_POST]: post(over), ['GET ' + QUEUE]: {version: '1.5.0', items: []}});
    await assert.rejects(call(s, 'queue_editor_changes', args), pattern);
    assert(!s.calls.some(c => c.o.method === 'POST'));
  }
});

test('editor queue: an old bridge gets a clear "update the bridge" message, and nothing is written', async () => {
  const s = site({[GET_POST]: post(), ['GET ' + QUEUE]: noRoute, ['GET ' + QUEUE + '?content=1']: noRoute});
  await assert.rejects(call(s, 'queue_editor_changes', {content: '<p>New</p>'}), /need SEO Bridge 1\.5\.0 or later on site site-a.*Nothing was changed/);
  await assert.rejects(call(s, 'list_editor_changes', {}), /need SEO Bridge 1\.5\.0/);
  assert(!s.calls.some(c => c.o.method === 'POST'));
  const invalid = site({[GET_POST]: post(), ['GET ' + QUEUE]: {__status: 404, body: {code: 'rest_post_invalid_id', message: 'Invalid post ID.'}}});
  await assert.rejects(call(invalid, 'queue_editor_changes', {content: '<p>New</p>'}), /HTTP 404 \(rest_post_invalid_id\)/);
});

test('list_editor_changes: newest first; stale pending changes and saved applied changes are recognised', async () => {
  const items = [
    {id: '1111111111111111', status: 'applied', label: 'Saved one', created_gmt: '2026-10-19T09:00:00', updated_gmt: '2026-10-19T09:05:00', base_modified_gmt: '2026-10-19T08:00:00', summary: [{before: 'a', after: 'b'}], content: content.replace(/></g, '>\n<')},
    {id: '2222222222222222', status: 'pending', label: 'Old base', created_gmt: '2026-10-19T10:00:00', base_modified_gmt: '2026-10-19T08:00:00', summary: [], content: '<p>x</p>'},
    {id: '3333333333333333', status: 'pending', label: 'Current', created_gmt: '2026-10-20T11:00:00', base_modified_gmt: '2026-10-20T10:00:00', summary: [{before: 'c', after: 'd'}], content: '<p>y</p>'},
    {id: '4444444444444444', status: 'applied', label: 'Unsaved', created_gmt: '2026-10-20T11:30:00', base_modified_gmt: '2026-10-20T10:00:00', summary: [], content: '<p>z</p>'},
  ];
  const s = site({[GET_POST]: post(), ['GET ' + QUEUE + '?content=1']: {version: '1.5.0', post_id: 1941, items}});
  const r = await call(s, 'list_editor_changes', {});
  assert.equal(r.data.pending, 2);
  assert.deepEqual(r.data.items.map(i => i.batch_id), ['4444444444444444', '3333333333333333', '2222222222222222', '1111111111111111']);
  const byId = Object.fromEntries(r.data.items.map(i => [i.batch_id, i]));
  assert.equal(byId['2222222222222222'].stale, true);
  assert.equal(byId['3333333333333333'].stale, undefined);
  assert.equal(byId['1111111111111111'].saved, true, 'whitespace between tags is ignored');
  assert.equal(byId['4444444444444444'].saved, false);
  assert.match(byId['4444444444444444'].note, /not saved yet/);
  assert(!JSON.stringify(r.data).includes('<p>y</p>'), 'content is not returned');
});

test('cancel_editor_change: dismisses a pending change; finished ones are left alone', async () => {
  const items = [{id: '3333333333333333', status: 'pending'}, {id: '1111111111111111', status: 'applied'}];
  const s = site({
    [GET_POST]: post(),
    ['GET ' + QUEUE]: {version: '1.5.0', items},
    ['POST ' + QUEUE + '/3333333333333333']: {id: '3333333333333333', status: 'dismissed'},
  });
  const r = await call(s, 'cancel_editor_change', {batch_id: '3333333333333333'});
  assert.equal(r.data.queue_status, 'dismissed');
  assert.deepEqual(s.calls.at(-1).body, {status: 'dismissed'});
  const done = await call(s, 'cancel_editor_change', {batch_id: '1111111111111111'});
  assert.match(done.data.note, /already applied; nothing was changed/);
  assert.equal(s.calls.filter(c => c.o.method === 'POST').length, 1);
  await assert.rejects(call(s, 'cancel_editor_change', {batch_id: 'ffffffffffffffff'}), /no queued change ffffffffffffffff/);
  await assert.rejects(call(s, 'cancel_editor_change', {batch_id: 'nope'}), /batch_id must be a batch_id/);
});
