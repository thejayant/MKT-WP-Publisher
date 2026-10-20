'use strict';
// Opt-in end-to-end test against a real WordPress site. Use a STAGING site, never production.
// It never publishes or schedules. With WP_LIVE_ALLOW_WRITES=yes it creates one draft and moves it to the trash at the end.
//
//   WP_LIVE_URL            https://staging.example.com (required)
//   WP_LIVE_USERNAME       WordPress user (required)
//   WP_LIVE_APP_PASSWORD   Application Password for that user (required)
//   WP_LIVE_ALLOW_WRITES   yes = create, update and trash a test draft
//   WP_LIVE_UPLOAD         yes = also upload a 1x1 PNG, set it as the draft's featured image, then delete it
//   WP_LIVE_SEO            yes = also write SEO fields (needs the SEO Bridge plugin and Yoast or Rank Math)
//
// Run: npm run test:live
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {makeService} = require('../../server/service.js');

const {WP_LIVE_URL, WP_LIVE_USERNAME, WP_LIVE_APP_PASSWORD} = process.env;
const writes = process.env.WP_LIVE_ALLOW_WRITES === 'yes';
const upload = writes && process.env.WP_LIVE_UPLOAD === 'yes';
const seo = writes && process.env.WP_LIVE_SEO === 'yes';
const configured = WP_LIVE_URL && WP_LIVE_USERNAME && WP_LIVE_APP_PASSWORD;
const skip = configured ? false : 'Set WP_LIVE_URL, WP_LIVE_USERNAME and WP_LIVE_APP_PASSWORD to run against a staging site.';
// A valid 1x1 transparent PNG.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('live WordPress round trip', {skip}, async t => {
  const imageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wp-live-'));
  await fs.writeFile(path.join(imageDir, 'mkt-live-test.png'), PIXEL);
  const env = {WP_SITES_JSON: JSON.stringify([{id: 'live', site_url: WP_LIVE_URL, username: WP_LIVE_USERNAME, application_password: WP_LIVE_APP_PASSWORD, image_folder: imageDir}])};
  const call = makeService(env);
  const auth = 'Basic ' + Buffer.from(WP_LIVE_USERNAME + ':' + WP_LIVE_APP_PASSWORD.replace(/\s/g, '')).toString('base64');
  const cleanup = [];

  try {
    const connection = await call('test_connection', {site_id: 'live'});
    t.diagnostic('connected as ' + connection.data.slug + ' (' + connection.data.roles?.join(', ') + '), REST style ' + connection.data.rest_api_style);
    assert.equal(connection.data.connected, true);
    assert.equal((await call('list_categories', {site_id: 'live'})).site_id, 'live');
    await call('list_tags', {site_id: 'live'});
    await call('list_authors', {site_id: 'live'});
    await call('list_posts', {site_id: 'live'});
    if (!writes) {
      t.diagnostic('Read-only run. Set WP_LIVE_ALLOW_WRITES=yes to test drafts.');
      return;
    }

    const slug = 'mkt-live-test-' + Date.now();
    const draft = await call('create_draft', {
      site_id: 'live',
      title: 'MKT live test ' + slug,
      slug,
      content_format: 'markdown',
      content: '## Live test\n\nCreated by **npm run test:live**. Safe to delete.',
      ...(seo ? {seo: {title: 'MKT live test', description: 'Automated test draft.', focus_keyword: 'mkt live test'}} : {}),
    });
    const postId = draft.data.post_id;
    // Trash (not delete) the draft, so it can still be inspected after a failure.
    cleanup.push(() => fetch(WP_LIVE_URL.replace(/\/$/, '') + '/wp-json/wp/v2/posts/' + postId, {method: 'DELETE', headers: {Authorization: auth}}));
    assert.equal(draft.data.status, 'draft');
    assert.match(draft.data.preview_url, /preview=true/);
    if (seo) assert.equal(draft.data.seo?.title, 'MKT live test');

    const read = await call('get_post', {site_id: 'live', post_id: postId});
    assert.match(read.data.content, /<h2>Live test<\/h2>/);
    const updated = await call('update_draft', {site_id: 'live', post_id: postId, title: 'MKT live test (updated) ' + slug, expected_modified_gmt: read.data.modified_gmt});
    assert.match(updated.data.title.raw ?? updated.data.title, /updated/);
    const found = await call('list_posts', {site_id: 'live', search: slug});
    assert(found.data.items.some(p => p.post_id === postId), 'list_posts finds the new draft');

    if (upload) {
      const media = await call('upload_image', {site_id: 'live', file_name: 'mkt-live-test.png', alt_text: 'MKT live test pixel', featured_for_post_id: postId});
      cleanup.push(() => fetch(WP_LIVE_URL.replace(/\/$/, '') + '/wp-json/wp/v2/media/' + media.data.media_id + '?force=true', {method: 'DELETE', headers: {Authorization: auth}}));
      assert.match(media.data.html, /wp-image-/);
      assert.equal((await call('get_post', {site_id: 'live', post_id: postId})).data.featured_media, media.data.media_id);
    }
  } finally {
    for (const step of cleanup.reverse()) {
      try {
        await step();
      } catch (error) {
        t.diagnostic('cleanup failed: ' + error.message + '. Remove the test draft/image manually.');
      }
    }
    await fs.rm(imageDir, {recursive: true, force: true});
  }
});
