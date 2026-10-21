'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {makeService} = require('../server/service.js');
const {env, mock} = require('./helpers.js');
const {parse, outline, applyChanges, serializeAttrs} = require('../server/blocks.js');

// Content shaped like the Direct Metal Structures state pages: core blocks, nested columns, an ACF block, classic HTML.
const PAGE = [
  '<!-- wp:heading {"level":2} -->',
  '<h2 class="wp-block-heading">Metal Buildings Florida</h2>',
  '<!-- /wp:heading -->',
  '',
  '<!-- wp:paragraph -->',
  '<p>Direct Metal Structures supplies garages across all 67 Florida counties &amp; more.</p>',
  '<!-- /wp:paragraph -->',
  '',
  '<!-- wp:columns -->',
  '<div class="wp-block-columns"><!-- wp:column -->',
  '<div class="wp-block-column"><!-- wp:paragraph -->',
  '<p>Left column text.</p>',
  '<!-- /wp:paragraph --></div>',
  '<!-- /wp:column --></div>',
  '<!-- /wp:columns -->',
  '',
  '<!-- wp:acf/faq {"name":"acf/faq","data":{"question_1":"How long is delivery?","_question_1":"field_abc","answer_1":"About 4\\u002d6 weeks."},"mode":"preview"} /-->',
  '',
  '<p>Classic HTML chunk at the end.</p>',
].join('\n');

test('blocks: outline numbers top-level and nested blocks, shows text and ACF fields', () => {
  const o = outline(PAGE);
  assert.deepEqual(o.blocks.map(b => b.block + ' ' + b.name), ['0 core/heading', '1 core/paragraph', '2 core/columns', '2.0 core/column', '2.0.0 core/paragraph', '3 acf/faq', '4 html']);
  assert.equal(o.blocks[1].text, 'Direct Metal Structures supplies garages across all 67 Florida counties & more.');
  assert.equal(o.blocks[2].inner_blocks, 1);
  assert.deepEqual(o.blocks[5].fields, {question_1: 'How long is delivery?', answer_1: 'About 4-6 weeks.'});
  assert.equal(o.total, 7);
  assert.deepEqual(outline('<p>Old classic post.</p>').blocks.map(b => b.name), ['html'], 'classic content is one html entry');
});

test('blocks: edits change only their target, everything else stays byte-for-byte', () => {
  const {content, diff, edits} = applyChanges(PAGE, [
    {block: '1', replace_text: {find: 'all 67 Florida counties & more', with: 'every county in Florida'}},
    {block: '2.0.0', replace_text: {find: 'Left column text.', with: 'Left column, edited.'}},
  ]);
  assert.equal(edits, 2);
  assert.equal(diff.length, 2);
  assert.equal(content, PAGE.replace('all 67 Florida counties &amp; more', 'every county in Florida').replace('Left column text.', 'Left column, edited.'));
});

test('blocks: ACF block fields are edited inside the block attributes with WordPress escaping', () => {
  const {content} = applyChanges(PAGE, [{block: '3', acf_data: {question_1: 'Delivery <time> -- & cost?'}}]);
  const acf = parse(content).children[3];
  assert.equal(acf.attrs.data.question_1, 'Delivery <time> -- & cost?');
  assert.equal(acf.attrs.data._question_1, 'field_abc', 'field keys kept');
  assert(content.includes('\\u003ctime\\u003e \\u002d\\u002d \\u0026 cost?'), 'escaped like serialize_block_attributes, so the comment stays valid');
  assert(!/data":\{[^}]*-->/.test(content));
  assert.equal(serializeAttrs({a: 'x"y'}), '{"a":"x\\u0022y"}');
});

test('blocks: ambiguous, missing, structural and unsafe changes are refused and change nothing', () => {
  const refuse = (changes, re) => assert.throws(() => applyChanges(PAGE, changes), re);
  refuse([{replace_text: {find: 'paragraph', with: 'x'}}], /not found/); // only inside delimiters
  refuse([{block: '1', replace_text: {find: 'Left column', with: 'x'}}], /not found in block 1/); // lives in a nested block
  refuse([{replace_text: {find: 'e', with: 'x'}}], /appears \d+ times/);
  refuse([{block: '9', replace_text: {find: 'a', with: 'b'}}], /no block 9/);
  refuse([{block: '3', acf_data: {nope: 'x'}}], /no field "nope". Fields: question_1, answer_1/);
  refuse([{block: '1', acf_data: {x: 'y'}}], /has no ACF data/);
  refuse([{replace_text: {find: 'Left column text.', with: '<!-- wp:paragraph -->x'}}], /block comment markers/);
  refuse([{block: '1', replace_text: {find: 'all 67', with: 'a'}}, {block: '1', replace_text: {find: '67 Florida', with: 'b'}}], /touch the same text/);
  refuse([{block: '1', replace_text: {find: 'x', with: 'y'}, acf_data: {}}], /exactly one of/);
  refuse([{block: '1', replace: 'x'}], /unknown keys: replace/);
  refuse([], /non-empty list/);
  assert.throws(() => parse('<!-- wp:paragraph --><p>never closed</p>'), /never closed/);
  assert.throws(() => parse('<p>x</p><!-- /wp:paragraph -->'), /unexpected closing/);
});

test('blocks: all:true replaces every match; HTML-escaped text is found', () => {
  const {content, edits} = applyChanges(PAGE, [{replace_text: {find: 'Florida', with: 'FL', all: true}}]);
  assert.equal(edits, 2);
  assert(!content.includes('Florida'));
  assert(applyChanges(PAGE, [{replace_text: {find: 'counties & more', with: 'counties & beyond'}}]).content.includes('counties &amp; beyond'));
});

test('edit_blocks: reads raw content, confirms the title, saves only the changed content, returns a diff', async () => {
  const post = {id: 1941, type: 'page', status: 'publish', title: {raw: 'Florida'}, modified_gmt: '2026-10-21T10:00:00', content: {raw: PAGE}};
  const after = PAGE.replace('all 67 Florida counties &amp; more', 'every Florida county');
  const m = mock([post, {...post, content: {raw: after}}]);
  const r = await makeService(env, m.f)('edit_blocks', {site_id: 'site-a', post_type: 'page', post_id: 1941, changes: [{block: '1', replace_text: {find: 'all 67 Florida counties & more', with: 'every Florida county'}}], confirm_title: 'Florida', confirm_edit: true, expected_modified_gmt: '2026-10-21T10:00:00'});
  assert.match(m.calls[0].u, /\/pages\/1941\?context=edit$/);
  assert.deepEqual(JSON.parse(m.calls[1].o.body), {content: after});
  assert.equal(r.data.live, true);
  assert.equal(r.data.changes.length, 1);
  assert(!r.data.warning);

  const filtered = mock([post, {...post, content: {raw: after.replace('<h2', '<h3')}}]);
  const w = await makeService(env, filtered.f)('edit_blocks', {site_id: 'site-a', post_type: 'page', post_id: 1941, changes: [{block: '1', replace_text: {find: 'all 67 Florida counties & more', with: 'every Florida county'}}], confirm_title: 'Florida', confirm_edit: true});
  assert.match(w.data.warning, /WordPress changed the content while saving/);

  const wrong = mock([post]);
  await assert.rejects(makeService(env, wrong.f)('edit_blocks', {site_id: 'site-a', post_type: 'page', post_id: 1941, changes: [{replace_text: {find: 'x', with: 'y'}}], confirm_title: 'Other', confirm_edit: true}), /does not match/);
  const missing = mock([post]);
  await assert.rejects(makeService(env, missing.f)('edit_blocks', {site_id: 'site-a', post_type: 'page', post_id: 1941, changes: [{replace_text: {find: 'not on the page', with: 'y'}}], confirm_title: 'Florida', confirm_edit: true}), /not found/);
  assert(missing.calls.every(c => c.o.method === 'GET'), 'nothing written when a change fails');
  const noRaw = mock([{...post, content: {rendered: '<p>x</p>'}}]);
  await assert.rejects(makeService(env, noRaw.f)('edit_blocks', {site_id: 'site-a', post_type: 'page', post_id: 1941, changes: [{replace_text: {find: 'x', with: 'y'}}], confirm_title: 'Florida', confirm_edit: true}), /needs permission to edit/);
  await assert.rejects(makeService(env, mock([]).f)('edit_blocks', {site_id: 'site-a', post_id: 1, changes: 'nope', confirm_title: 'T', confirm_edit: true}), /must be a list of objects/);
});

test('list_blocks: returns the outline with title and modified time', async () => {
  const m = mock([{id: 5, type: 'post', status: 'draft', title: {raw: 'T'}, modified_gmt: '2026-10-21T09:00:00', content: {raw: PAGE}}]);
  const r = await makeService(env, m.f)('list_blocks', {site_id: 'site-a', post_id: 5});
  assert.equal(r.data.uses_blocks, true);
  assert.equal(r.data.blocks.length, 7);
  assert.equal(r.data.modified_gmt, '2026-10-21T09:00:00');
});
