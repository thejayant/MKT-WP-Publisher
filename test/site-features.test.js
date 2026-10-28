'use strict';
// The site context, brand style, preview, staged-edit, page-builder and content-loss checks, shared with WP Publisher
// for ChatGPT (its test/features.test.js, run here against the Claude extension's dispatcher). WordPress is a pretend
// site; each test checks the exact requests sent, so an edit that should be refused is shown to send no write at all.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const {makeService} = require('../server/service.js');
const {slot} = require('./helpers.js');

const PASSWORD = 'abcd EFGH 1234 ijkl';
const LIVE_CONTENT = '<!-- wp:paragraph --><p>First paragraph about carports.</p><!-- /wp:paragraph --><!-- wp:paragraph --><p>Second paragraph stays.</p><!-- /wp:paragraph --><!-- wp:image --><figure><img src="https://blog.example.com/a.jpg" alt=""></figure><!-- /wp:image -->';

/** A pretend WordPress. posts: id -> post object; extra: route -> reply value. Records every request. */
function wordpress({posts = {}, extra = {}} = {}) {
  const calls = [];
  const reply = (status, value) => ({ok: status < 300, status, headers: {get: () => null}, json: async () => value});
  async function fetcher(url, options = {}) {
    const u = new URL(url);
    const method = options.method || 'GET';
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
    calls.push({host: u.hostname, method, path: u.pathname, query: u.search, body});
    const route = u.pathname.replace(/^\/wp-json\/wp\/v2/, '');
    const key = method + ' ' + (u.pathname === '/wp-json/' ? '/' : route);
    if (Object.hasOwn(extra, key)) {
      const value = extra[key];
      return value instanceof Error ? reply(value.status, {code: value.code, message: value.message}) : reply(200, value);
    }
    const match = route.match(/^\/(posts|pages)\/(\d+)(\/autosaves)?$/);
    if (match && posts[match[2]]) {
      const post = posts[match[2]];
      if (match[3] && method === 'POST') return reply(200, {id: 900, parent: post.id, ...body});
      if (method === 'GET') return reply(200, post);
      if (method === 'POST') {
        Object.assign(post, body.content !== undefined ? {content: {raw: body.content, rendered: body.content}} : {}, body.title !== undefined ? {title: {raw: body.title}} : {});
        return reply(200, post);
      }
    }
    if (method === 'GET' && /^\/(posts|pages)$/.test(route)) return reply(200, []);
    return reply(404, {code: 'rest_no_route', message: 'No route.'});
  }
  return {fetcher, calls, writes: () => calls.filter(c => c.method === 'POST')};
}

const post = (id, fields = {}) => ({
  id, type: 'post', status: 'publish', link: 'https://blog.example.com/p' + id, slug: 'p' + id, title: {raw: 'Post ' + id}, author: 3, featured_media: 0, categories: [1],
  excerpt: {raw: ''}, content: {raw: LIVE_CONTENT, rendered: LIVE_CONTENT}, date_gmt: '2026-10-01T00:00:00', modified_gmt: '2026-10-01T00:00:00', ...fields,
});

// website-1 is a normal website; website-2 is set to read-only in the extension settings.
const ENV = {
  ...slot(1, os.tmpdir(), {LABEL: 'Company Blog', URL: 'https://blog.example.com', USERNAME: 'priya', APP_PASSWORD: PASSWORD}),
  ...slot(2, os.tmpdir(), {LABEL: 'Client Shop', URL: 'https://shop.example.com', USERNAME: 'priya', APP_PASSWORD: PASSWORD, READ_ONLY: 'true'}),
};

test('existing edits make exactly the same requests as before on ordinary posts', async () => {
  const wp = wordpress({posts: {10: post(10)}});
  const call = makeService(ENV, wp.fetcher);
  const out = await call('edit_published_post', {site_id: 'website-1', post_id: 10, content: '<p>New</p>', confirm_title: 'Post 10', confirm_edit: true});
  assert.equal(out.data.post_id, 10);
  assert.deepEqual(wp.calls.map(c => c.method + ' ' + c.path), ['GET /wp-json/wp/v2/posts/10', 'POST /wp-json/wp/v2/posts/10']);
  assert.deepEqual(wp.writes()[0].body, {content: '<p>New</p>'});
});

test('content edits on page-builder pages are refused before anything is written', async () => {
  const elementor = post(20, {type: 'page', template: 'elementor_header_footer'});
  const wpbakery = post(30, {content: {raw: '[vc_row][vc_column][vc_column_text]Hello world[/vc_column_text][/vc_column][/vc_row]', rendered: ''}});
  // SEO Bridge 1.4.0 answered "no builder", which wins over markup that looks like one.
  const bridgedPlain = post(40, {mkt_builder: null, content: {raw: '<p>x</p>', rendered: '<div data-elementor-type="wp-post">x</div>'}});
  const bridgedBricks = post(41, {mkt_builder: {id: 'bricks', name: 'Bricks', storage: 'meta'}});
  const wp = wordpress({posts: {20: elementor, 30: wpbakery, 40: bridgedPlain, 41: bridgedBricks}});
  const call = makeService(ENV, wp.fetcher);
  const page = {site_id: 'website-1', post_type: 'page', post_id: 20, confirm_title: 'Post 20', confirm_edit: true};

  await assert.rejects(call('edit_published_post', {...page, content: '<p>Replaced</p>'}), /built with Elementor.*Nothing was saved/);
  await assert.rejects(call('edit_blocks', {...page, changes: [{replace_text: {find: 'Second', with: 'Other'}}]}), /built with Elementor/);
  await assert.rejects(call('edit_published_post', {site_id: 'website-1', post_id: 41, content: '<p>x</p>', confirm_title: 'Post 41', confirm_edit: true}), /built with Bricks/);
  assert.equal(wp.writes().length, 0, 'nothing written');

  // Fields other than content still work on builder pages.
  await call('edit_published_post', {...page, title: 'New title'});
  // WPBakery keeps its layout in the content: whole replacement refused, text changes inside it allowed.
  await assert.rejects(call('edit_published_post', {site_id: 'website-1', post_id: 30, content: '<p>x</p>', confirm_title: 'Post 30', confirm_edit: true}), /replacing the whole content would remove that layout/);
  const edited = await call('edit_blocks', {site_id: 'website-1', post_id: 30, changes: [{replace_text: {find: 'Hello world', with: 'Hello there'}}], confirm_title: 'Post 30', confirm_edit: true});
  assert.equal(edited.data.edits, 1);
  // The user's explicit override, and the bridge's "no builder" answer.
  await call('edit_published_post', {...page, content: '<p>Replaced</p>', confirm_title: 'New title', allow_page_builder: true});
  await call('edit_published_post', {site_id: 'website-1', post_id: 40, content: '<p>y</p>', confirm_title: 'Post 40', confirm_edit: true});
  assert.equal(wp.writes().length, 4);

  const read = await call('get_post', {site_id: 'website-1', post_id: 41});
  assert.deepEqual(read.data.page_builder, {id: 'bricks', name: 'Bricks', storage: 'meta', source: 'seo-bridge'});
  assert.equal((await call('get_post', {site_id: 'website-1', post_id: 40})).data.page_builder, undefined);
});

test('preview_edit shows the change field by field and paragraph by paragraph, and writes nothing', async () => {
  const wp = wordpress({posts: {10: post(10, {mkt_seo: {plugin: 'yoast', title: 'Old SEO'}})}, extra: {
    'OPTIONS /posts': {schema: {properties: {mkt_seo: {properties: {plugin: {enum: ['yoast']}, version: {enum: ['1.4.0']}, canonical: {}}}}}},
  }});
  const call = makeService(ENV, wp.fetcher);
  const out = (await call('preview_edit', {
    site_id: 'website-1', post_id: 10, title: 'Post 10', slug: 'carports-guide', seo: {title: 'New SEO'},
    content: '<!-- wp:paragraph --><p>Second paragraph stays.</p><!-- /wp:paragraph --><p>A new closing line.</p>',
  })).data;
  assert.equal(wp.writes().length, 0);
  assert.deepEqual(out.fields, [{field: 'slug', before: 'p10', after: 'carports-guide'}, {field: 'seo.title', before: 'Old SEO', after: 'New SEO'}]);
  assert.deepEqual(out.content.removed, ['First paragraph about carports.']);
  assert.deepEqual(out.content.added, ['A new closing line.']);
  assert.equal(out.content.media_before, 1);
  assert.equal(out.content.media_after, 0);
  assert.equal(out.apply_with.tool, 'edit_published_post');
  assert.equal(out.apply_with.expected_modified_gmt, '2026-10-01T00:00:00');
  assert.match(out.warning, /public URL/);

  const blocks = (await call('preview_edit', {site_id: 'website-1', post_id: 10, changes: [{block: 1, replace_text: {find: 'stays', with: 'changed'}}]})).data;
  assert.equal(blocks.apply_with.tool, 'edit_blocks');
  assert.equal(blocks.content.block_changes.length, 1);
  assert.deepEqual(blocks.content.added, ['Second paragraph changed.']);
  await assert.rejects(call('preview_edit', {site_id: 'website-1', post_id: 10, title: 'x', changes: [{replace_text: {find: 'a', with: 'b'}}]}), /either changes .* or fields/);
  await assert.rejects(call('preview_edit', {site_id: 'website-1', post_id: 10, title: 'x', expected_modified_gmt: '2025-01-01T00:00:00'}), /changed since you read it/);
  assert.equal(wp.writes().length, 0);
});

test('stage_edit saves an autosave of the live post and leaves the post itself alone', async () => {
  const wp = wordpress({posts: {10: post(10, {excerpt: {raw: 'Short'}}), 11: post(11, {status: 'draft'})}});
  const call = makeService(ENV, wp.fetcher);
  const out = (await call('stage_edit', {site_id: 'website-1', post_id: 10, changes: [{block: 0, replace_text: {find: 'carports', with: 'garages'}}]})).data;
  const writes = wp.writes();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/wp-json/wp/v2/posts/10/autosaves');
  assert.equal(writes[0].body.title, 'Post 10', 'unchanged title sent so the autosave is complete');
  assert.equal(writes[0].body.excerpt, 'Short');
  assert.match(writes[0].body.content, /garages/);
  assert.equal(out.autosave_id, 900);
  assert.equal(out.review.editor_url, 'https://blog.example.com/wp-admin/post.php?post=10&action=edit');
  // Only title, content and excerpt fit in an autosave, so the schema takes nothing else.
  await assert.rejects(call('stage_edit', {site_id: 'website-1', post_id: 10, slug: 'other'}), /Unknown argument/);
  await assert.rejects(call('stage_edit', {site_id: 'website-1', post_id: 11, title: 'x'}), /use|update_draft/);
  assert.equal(wp.writes().length, 1);
});

test('get_site_context works for an editor account, detecting plugins from the REST API', async () => {
  const forbidden = Object.assign(new Error('Sorry, you are not allowed.'), {status: 403, code: 'rest_forbidden'});
  const wp = wordpress({extra: {
    'GET /': {name: 'Company Blog', description: 'Carports', home: 'https://blog.example.com', gmt_offset: 5.5, timezone_string: 'Asia/Kolkata', namespaces: ['wp/v2', 'yoast/v1', 'wc/v3', 'elementor/v1', 'litespeed/v1']},
    'GET /users/me': {id: 3, name: 'Priya', roles: ['editor'], capabilities: {publish_posts: true, upload_files: true, edit_others_posts: true}},
    'GET /settings': forbidden,
    'GET /plugins': forbidden,
    'GET /themes': [{stylesheet: 'astra-child', template: 'astra', name: {raw: 'Astra Child'}, version: '1.0', is_block_theme: false}],
    'OPTIONS /posts': {schema: {properties: {mkt_seo: {properties: {plugin: {enum: ['yoast']}, version: {enum: ['1.4.0']}}}, mkt_fields: {}, mkt_builder: {}}}},
    'GET /types': {post: {slug: 'post', name: 'Posts', rest_base: 'posts'}, page: {slug: 'page', name: 'Pages', rest_base: 'pages', hierarchical: true}, attachment: {slug: 'attachment', rest_base: 'media'}},
  }});
  const call = makeService(ENV, wp.fetcher);
  const ctx = (await call('get_site_context', {site_id: 'website-1'})).data;
  assert.equal(ctx.site.name, 'Company Blog');
  assert.equal(ctx.site.timezone, 'Asia/Kolkata');
  assert.equal(ctx.access.mode, 'full');
  assert.deepEqual(ctx.access.user.roles, ['editor']);
  assert.equal(ctx.plugins.detected_from, 'REST API namespaces');
  assert.deepEqual(ctx.plugins.seo.map(p => p.id), ['yoast']);
  assert.deepEqual(ctx.plugins.page_builders.map(p => p.id), ['elementor']);
  assert.deepEqual(ctx.plugins.store.map(p => p.id), ['woocommerce']);
  assert.deepEqual(ctx.seo_bridge, {installed: true, version: '1.4.0', seo_plugin: 'yoast', custom_fields: true, page_builder_detection: true});
  assert.deepEqual(ctx.post_types.map(t => t.post_type), ['post', 'page']);
  assert.equal(ctx.theme.parent, 'astra');
  assert.ok(ctx.notes.some(n => /administrator/.test(n)));
  assert.ok(ctx.guidance.some(g => /Elementor/.test(g)));
  assert.equal(wp.writes().length, 0);

  const readOnly = (await call('get_site_context', {site_id: 'website-2'})).data;
  assert.equal(readOnly.access.mode, 'read_only');
  assert.match(readOnly.guidance[0], /read-only/);
});

test('block types: compact list with filters, one type in detail, unknown names explained', async () => {
  const wp = wordpress({extra: {
    'GET /block-types': [
      {name: 'core/paragraph', title: 'Paragraph', category: 'text', description: 'Start with the basic building block.'},
      {name: 'core/column', title: 'Column', category: 'design', parent: ['core/columns']},
      {name: 'woocommerce/product-price', title: 'Product Price', category: 'woocommerce', is_dynamic: true},
    ],
    'GET /block-types/core/heading': {
      name: 'core/heading', title: 'Heading', category: 'text', is_dynamic: false,
      attributes: {content: {type: 'rich-text', source: 'rich-text', selector: 'h1,h2,h3,h4,h5,h6'}, level: {type: 'integer', default: 2}, textAlign: {type: 'string'}, lock: {type: 'object'}},
      supports: {color: {link: true}}, styles: [], variations: [{name: 'h2', title: 'Heading 2', attributes: {level: 2}}],
    },
  }});
  const call = makeService(ENV, wp.fetcher);
  const all = (await call('list_block_types', {site_id: 'website-1'})).data;
  assert.equal(all.count, 3);
  assert.deepEqual(all.namespaces, {core: 2, woocommerce: 1});
  assert.deepEqual(all.block_types.find(b => b.name === 'core/column').parent, ['core/columns']);
  assert.deepEqual((await call('list_block_types', {site_id: 'website-1', search: 'price'})).data.block_types.map(b => b.name), ['woocommerce/product-price']);

  const heading = (await call('get_block_type', {site_id: 'website-1', name: 'core/heading'})).data;
  assert.deepEqual(heading.attributes.level, {type: 'integer', default: 2});
  assert.equal(heading.attributes.content.source, 'rich-text');
  assert.equal(heading.attributes.lock, undefined);
  assert.match(heading.how_to_write, /<!-- wp:heading/);
  await assert.rejects(call('get_block_type', {site_id: 'website-1', name: 'acme/missing'}), /not registered on site website-1/);
  await assert.rejects(call('get_block_type', {site_id: 'website-1', name: 'Bad Name'}), /must be a block name/);
});

test('brand styles merge the Site Editor palette over the theme and explain preset slugs', async () => {
  const wp = wordpress({extra: {
    'GET /themes': [{stylesheet: 'twentytwentyfour', template: 'twentytwentyfour', name: {raw: 'Twenty Twenty-Four'}, is_block_theme: true, _links: {'wp:user-global-styles': [{href: 'https://blog.example.com/wp-json/wp/v2/global-styles/55'}]}}],
    'GET /global-styles/themes/twentytwentyfour': {
      settings: {color: {palette: [{slug: 'base', name: 'Base', color: '#ffffff'}, {slug: 'contrast', name: 'Contrast', color: '#111111'}]}, typography: {fontSizes: [{slug: 'large', name: 'Large', size: '1.5rem'}]}, layout: {contentSize: '620px', wideSize: '1280px'}},
      styles: {color: {background: 'var:preset|color|base', text: 'var:preset|color|contrast'}},
    },
    'GET /global-styles/55': {settings: {color: {palette: {theme: [{slug: 'contrast', name: 'Contrast', color: '#0a2540'}], custom: [{slug: 'brand', name: 'Brand', color: '#ff765c'}]}}}, styles: {}},
  }});
  const call = makeService(ENV, wp.fetcher);
  const out = (await call('get_brand_styles', {site_id: 'website-1'})).data;
  assert.deepEqual(out.colors.map(c => [c.slug, c.color]), [['base', '#ffffff'], ['contrast', '#0a2540'], ['brand', '#ff765c']]);
  assert.equal(out.colors[2].css, 'var(--wp--preset--color--brand)');
  assert.deepEqual(out.font_sizes, [{slug: 'large', name: 'Large', size: '1.5rem'}]);
  assert.deepEqual(out.layout, {content_size: '620px', wide_size: '1280px'});
  assert.equal(out.base_styles.background, 'var(--wp--preset--color--base)');
  assert.equal(out.theme.block_theme, true);
});

test('SEO fields: AIOSEO and SEOPress need the 1.4.0 bridge; Yoast and Rank Math work as before', async () => {
  const bridge = (plugin, version) => ({'OPTIONS /posts': {schema: {properties: {mkt_seo: {properties: {plugin: {enum: [plugin]}, version: {enum: [version]}, canonical: {}}}}}}});
  for (const plugin of ['yoast', 'rank-math', 'aioseo', 'seopress']) {
    const wp = wordpress({posts: {11: post(11, {status: 'draft'})}, extra: bridge(plugin, '1.4.0')});
    const call = makeService(ENV, wp.fetcher);
    await call('update_draft', {site_id: 'website-1', post_id: 11, seo: {title: 'SEO title', canonical: 'https://blog.example.com/x'}});
    assert.deepEqual(wp.writes()[0].body.mkt_seo, {title: 'SEO title', canonical: 'https://blog.example.com/x'}, plugin);
  }
  // A 1.3.0 bridge on a site with only AIOSEO or SEOPress reports "none".
  const old = wordpress({posts: {11: post(11, {status: 'draft'})}, extra: bridge('none', '1.3.0')});
  await assert.rejects(makeService(ENV, old.fetcher)('update_draft', {site_id: 'website-1', post_id: 11, seo: {title: 'x'}}), /need SEO Bridge 1\.4\.0 or later/);
  assert.equal(old.writes().length, 0);
});

test('content-loss guard: a shortened copy is refused with nothing written; real edits and explicit removals pass', async () => {
  const para = n => '<!-- wp:paragraph --><p>Paragraph ' + n + ' explains how to choose and install a carport that lasts for many years.</p><!-- /wp:paragraph -->';
  const img = n => '<!-- wp:image --><figure><img src="https://blog.example.com/' + n + '.jpg" alt=""></figure><!-- /wp:image -->';
  const long = [1, 2, 3, 4, 5].map(para).join('') + [1, 2, 3, 4].map(img).join('');
  const make = () => ({10: post(10, {content: {raw: long, rendered: long}}), 11: post(11, {status: 'draft', content: {raw: long, rendered: long}})});
  let wp = wordpress({posts: make()});
  let call = makeService(ENV, wp.fetcher);
  const live = {site_id: 'website-1', post_id: 10, confirm_title: 'Post 10', confirm_edit: true};

  // The typical accident: one paragraph sent back instead of the whole post.
  await assert.rejects(call('edit_published_post', {...live, content: para(1)}), /keeps \d+ of \d+ characters of text and keeps 0 of 4 images.*Nothing was saved/);
  await assert.rejects(call('update_draft', {site_id: 'website-1', post_id: 11, content: para(1)}), /content was lost/);
  // Text kept but most images dropped.
  await assert.rejects(call('edit_published_post', {...live, content: [1, 2, 3, 4, 5].map(para).join('') + img(1)}), /keeps 1 of 4 images/);
  // An image left without a source.
  await assert.rejects(call('edit_blocks', {...live, changes: [{replace_text: {find: ' src="https://blog.example.com/1.jpg"', with: ''}}]}), /adds images or embeds with no source/);
  await assert.rejects(call('stage_edit', {site_id: 'website-1', post_id: 10, content: para(1)}), /content was lost/);
  assert.equal(wp.writes().length, 0, 'nothing written');

  // preview_edit warns and reports instead of refusing.
  const preview = (await call('preview_edit', {site_id: 'website-1', post_id: 10, content: para(1)})).data;
  assert.deepEqual(preview.content_loss.reasons, ['text', 'media']);
  assert.match(preview.warning, /allow_content_loss/);

  // Ordinary edits pass: a sentence changed, one image of four removed, a paragraph added.
  await call('edit_blocks', {...live, changes: [{replace_text: {find: 'Paragraph 3 explains', with: 'Paragraph 3 shows'}}]});
  await call('edit_published_post', {...live, content: long.replace(img(4), '') + para(6)});
  assert.equal(wp.writes().length, 2);

  // The user's explicit choice to cut it down.
  wp = wordpress({posts: make()});
  call = makeService(ENV, wp.fetcher);
  await call('edit_published_post', {...live, content: para(1), allow_content_loss: true});
  assert.equal(wp.writes().length, 1);

  // Short posts (under 200 characters of text, under 3 images) are not checked, as before.
  wp = wordpress({posts: {10: post(10)}});
  await makeService(ENV, wp.fetcher)('edit_published_post', {...live, content: '<p>x</p>'});
  assert.equal(wp.writes().length, 1);
});
