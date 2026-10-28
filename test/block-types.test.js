'use strict';
// check_blocks: WordPress core's /wp/v2/block-types, no plugin needed. list_block_types and get_block_type are covered in
// site-features.test.js (shared with WP Publisher for ChatGPT).
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {makeService} = require('../server/service.js');
const {env, mock} = require('./helpers.js');

// A small registry like WordPress returns it (attributes from block.json, plus parent/ancestor rules).
const registry = () => [
  {name: 'core/paragraph', title: 'Paragraph', category: 'text', description: 'Start with the basic building block of all narrative.', keywords: ['text'], is_dynamic: false, attributes: {content: {type: 'rich-text', source: 'rich-text', selector: 'p'}, dropCap: {type: 'boolean', default: false}, align: {type: 'string'}}},
  {name: 'core/heading', title: 'Heading', category: 'text', is_dynamic: false, attributes: {level: {type: 'number', default: 2}, textAlign: {type: 'string'}, content: {type: 'rich-text', source: 'rich-text', selector: 'h1,h2,h3,h4,h5,h6'}}, supports: {anchor: true, className: false, color: {link: true}}, styles: [], variations: []},
  {name: 'core/columns', title: 'Columns', category: 'design', is_dynamic: false, attributes: {verticalAlignment: {type: 'string'}}, allowed_blocks: ['core/column']},
  {name: 'core/column', title: 'Column', category: 'design', is_dynamic: false, parent: ['core/columns'], attributes: {width: {type: 'string'}}},
  {name: 'core/latest-posts', title: 'Latest Posts', category: 'widgets', is_dynamic: true, attributes: {postsToShow: {type: 'number', default: 5}, order: {type: 'string', enum: ['asc', 'desc'], default: 'desc'}}},
  {name: 'core/comment-content', title: 'Comment Content', category: 'theme', is_dynamic: true, ancestor: ['core/comment-template'], attributes: {}},
  {name: 'acf/faq', title: 'FAQ', category: 'formatting', is_dynamic: true, attributes: {name: {type: 'string'}, data: {type: 'object'}, mode: {type: 'string'}}},
];

test('check_blocks: valid content passes; it reports unknown blocks, attribute types, enums and nesting', async () => {
  const good = '<!-- wp:heading {"level":3} --><h3>Hi</h3><!-- /wp:heading -->\n<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column --><div><!-- wp:paragraph --><p>A</p><!-- /wp:paragraph --></div><!-- /wp:column --></div><!-- /wp:columns -->\n<!-- wp:latest-posts {"order":"asc","className":"x","lock":{"move":true}} /-->';
  const ok = await makeService(env, mock([registry()]).f)('check_blocks', {site_id: 'site-a', content: good});
  assert.equal(ok.data.ok, true, JSON.stringify(ok.data.problems));
  assert.equal(ok.data.blocks_checked, 5);
  assert.deepEqual(ok.data.warnings, [], 'global attributes such as className and lock are not reported');

  const bad = '<!-- wp:column --><div></div><!-- /wp:column -->'
    + '<!-- wp:heading {"level":"three","extra":1} --><h2>x</h2><!-- /wp:heading -->'
    + '<!-- wp:latest-posts {"order":"random"} /-->'
    + '<!-- wp:acme/slider /-->'
    + '<!-- wp:columns --><div><!-- wp:paragraph --><p>x</p><!-- /wp:paragraph --></div><!-- /wp:columns -->'
    + '<!-- wp:comment-content /-->'
    + '<!-- wp:paragraph {"content":"ignored"} --><p>y</p><!-- /wp:paragraph -->'
    + '<!-- wp:heading /-->';
  const r = await makeService(env, mock([registry()]).f)('check_blocks', {site_id: 'site-a', content: bad});
  assert.equal(r.data.ok, false);
  const problems = r.data.problems.join('\n');
  assert.match(problems, /block 0 \(core\/column\): must be placed directly inside core\/columns, not at the top level/);
  assert.match(problems, /block 1 \(core\/heading\): attribute "level" must be number/);
  assert.match(problems, /block 2 \(core\/latest-posts\): attribute "order" must be one of: asc, desc/);
  assert.match(problems, /block 3 \(acme\/slider\): site site-a has no such block type/);
  assert.match(problems, /block 4 \(core\/columns\): may only contain core\/column, not core\/paragraph/);
  assert.match(problems, /block 5 \(core\/comment-content\): must be placed somewhere inside core\/comment-template/);
  assert.deepEqual(r.data.unknown_block_types, ['acme/slider']);
  const warnings = r.data.warnings.join('\n');
  assert.match(warnings, /attribute "extra" is not registered for core\/heading/);
  assert.match(warnings, /attribute "content" is read from the block's HTML/);
  assert.match(warnings, /block 7 \(core\/heading\): a static block written as a self-closing comment/);
});

test('check_blocks: broken block comments are reported without asking WordPress', async () => {
  const m = mock([]);
  const r = await makeService(env, m.f)('check_blocks', {site_id: 'site-a', content: '<!-- wp:paragraph --><p>x</p>'});
  assert.equal(r.data.ok, false);
  assert.match(r.data.problems[0], /never closed/);
  assert.equal(m.calls.length, 0);
  await assert.rejects(makeService(env, m.f)('check_blocks', {site_id: 'site-a', content: '  '}), /content cannot be blank/);
});
