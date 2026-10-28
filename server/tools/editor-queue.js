'use strict';
// Changes that wait in the block editor (SEO Bridge 1.5+, REST namespace mkt-seo-bridge/v1). queue_editor_changes
// prepares a new version of a post's content without saving it; whoever has the post open in the block editor sees it
// with Apply and Dismiss buttons, reviews it there and saves it. The post itself is never written by these tools.

const {markdownToHtml} = require('../markdown.js');
const {applyChanges} = require('../blocks.js');
const {raw} = require('../util.js');
const {postContext} = require('./posts.js');
const {detectBuilder} = require('../builders.js');

const NAMESPACE = 'mkt-seo-bridge/v1';
const MIN_BRIDGE = '1.5.0';
const QUEUE_STATUSES = ['draft', 'pending', 'future', 'publish', 'private'];

const stamp = text => String(text ?? '').replace(/(?:\.\d+)?(?:Z|\+00:00)$/i, '');
// Whitespace between tags differs after the editor re-serializes blocks, so compare without it.
const sameContent = (a, b) => String(a ?? '').replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

function fail(message) {
  throw new Error(message);
}

/** The queue of one post. A missing route means the bridge is missing or older than 1.5.0. */
async function readQueue(ctx, postId, withContent) {
  try {
    const queue = await ctx.request('/editor-queue/' + postId + (withContent ? '?content=1' : ''), {namespace: NAMESPACE});
    if (!queue || !Array.isArray(queue.items)) fail('WordPress returned an unexpected answer for the editor queue of site ' + ctx.site.site_id + '.');
    return queue;
  } catch (error) {
    if (error.status === 404 && (error.code === 'rest_no_route' || !error.code)) {
      fail('Changes in the block editor need SEO Bridge ' + MIN_BRIDGE + ' or later on site ' + ctx.site.site_id + '. In WordPress go to Plugins > Add New > Upload Plugin, upload mkt-wp-publisher-seo-bridge.zip and choose Replace current with uploaded. Nothing was changed.');
    }
    throw error;
  }
}

async function readPost(ctx, pc, postId) {
  const post = await ctx.request(pc.route + '/' + postId + '?context=edit');
  if (typeof post?.content?.raw !== 'string') {
    fail('WordPress did not return the stored content of ' + pc.kind + ' ' + postId + ' on site ' + ctx.site.site_id + '. The connected account needs permission to edit it.');
  }
  return post;
}

const editUrl = (ctx, postId) => ctx.site.site_url + '/wp-admin/post.php?post=' + postId + '&action=edit';

function about(pc, post) {
  return {post_id: post.id, ...(post.type ? {post_type: post.type} : {}), status: post.status, title: raw(post.title), modified_gmt: post.modified_gmt};
}

function describe(item, post) {
  const out = {
    batch_id: item.id,
    status: item.status,
    label: item.label,
    created_gmt: item.created_gmt,
    updated_gmt: item.updated_gmt,
    edits: Array.isArray(item.summary) ? item.summary.length : 0,
    summary: Array.isArray(item.summary) ? item.summary : [],
  };
  if (item.status === 'pending' && stamp(item.base_modified_gmt) !== stamp(post.modified_gmt)) {
    out.stale = true;
    out.note = 'The post was saved after this change was prepared, so the editor will refuse to apply it. Cancel it and queue the change again.';
  }
  if (item.status === 'applied') {
    out.saved = typeof item.content === 'string' && sameContent(item.content, post.content.raw);
    if (!out.saved) out.note = 'Applied in the editor but the saved content differs: it is not saved yet, or the person changed it before saving.';
  }
  return out;
}

module.exports = {
  async queue_editor_changes(ctx, args) {
    if ((args.changes === undefined) === (args.content === undefined)) fail('Pass either changes (block edits, as in edit_blocks) or content (the whole new content), not both.');
    if (args.content_format !== undefined && args.content === undefined) fail('content_format needs content.');
    if (args.content !== undefined && !args.content.trim()) fail('content cannot be blank.');
    if (args.label !== undefined && !args.label.trim()) fail('label cannot be blank.');
    const pc = await postContext(ctx, args);
    const post = await readPost(ctx, pc, args.post_id);
    if (args.expected_modified_gmt !== undefined && stamp(args.expected_modified_gmt) !== stamp(post.modified_gmt)) {
      fail(pc.kind[0].toUpperCase() + pc.kind.slice(1) + ' ' + args.post_id + ' on site ' + ctx.site.site_id + ' changed since you read it (modified_gmt is now ' + post.modified_gmt + '). Read it again and check with the user; nothing was queued.');
    }
    if (!QUEUE_STATUSES.includes(post.status)) fail('Changes can be queued for draft, pending, scheduled, published or private ' + pc.kind + 's; this one is ' + post.status + '.');
    const builder = detectBuilder(post);
    // Page-builder pages are edited in the builder, not the block editor, so the change would never be shown.
    if (builder) {
      fail('This ' + pc.kind + ' is built with ' + builder.name + ', so it is not edited in the block editor and the change would never be shown.' + (builder.id === 'elementor' ? ' Use get_elementor_layout and update_elementor_layout instead.' : '') + ' Nothing was queued.');
    }
    const before = post.content.raw;
    let content;
    let summary;
    if (args.changes !== undefined) {
      const result = applyChanges(before, args.changes);
      content = result.content;
      summary = result.diff.map(d => ({before: typeof d.before === 'string' ? d.before : JSON.stringify(d.before ?? ''), after: typeof d.after === 'string' ? d.after : JSON.stringify(d.after ?? '')}));
    } else {
      content = args.content_format === 'markdown' ? markdownToHtml(args.content) : args.content;
      summary = [{before: before.length ? before.length + ' characters' : '(empty)', after: 'whole new content, ' + content.length + ' characters'}];
    }
    if (content === before) fail('The changes leave the content exactly as it is. Nothing was queued.');
    // Read the queue first: it also tells whether the bridge supports it, before anything is written.
    await readQueue(ctx, args.post_id, false);
    const item = await ctx.request('/editor-queue/' + args.post_id, {
      namespace: NAMESPACE,
      method: 'POST',
      body: {content, base_modified_gmt: stamp(post.modified_gmt), label: args.label || 'Changes from Claude', summary},
    });
    if (!item || typeof item.id !== 'string') fail('WordPress did not confirm the queued change. Check with list_editor_changes before queueing it again.');
    return ctx.result({
      ...about(pc, post),
      batch_id: item.id,
      queue_status: item.status,
      label: item.label,
      changes: summary,
      edit_url: editUrl(ctx, args.post_id),
      next: 'Nothing is saved yet. Ask the user to open edit_url in the block editor (or keep it open): a notice offers Apply and Dismiss. Apply puts the change in the editor; it is kept only when they click Save or Update. Check progress with list_editor_changes.',
    });
  },

  async list_editor_changes(ctx, args) {
    const pc = await postContext(ctx, args);
    const post = await readPost(ctx, pc, args.post_id);
    const queue = await readQueue(ctx, args.post_id, true);
    const items = queue.items.map(item => describe(item, post)).reverse();
    return ctx.result({
      ...about(pc, post),
      bridge_version: queue.version,
      pending: items.filter(i => i.status === 'pending').length,
      items,
      edit_url: editUrl(ctx, args.post_id),
    });
  },

  async cancel_editor_change(ctx, args) {
    const pc = await postContext(ctx, args);
    const post = await readPost(ctx, pc, args.post_id);
    const queue = await readQueue(ctx, args.post_id, false);
    const current = queue.items.find(item => item.id === args.batch_id);
    if (!current) fail('There is no queued change ' + args.batch_id + ' on ' + pc.kind + ' ' + args.post_id + ' on site ' + ctx.site.site_id + ' (it may have expired after 14 days). Use list_editor_changes.');
    if (current.status !== 'pending') {
      return ctx.result({...about(pc, post), batch_id: current.id, queue_status: current.status, note: 'This change was already ' + current.status + '; nothing was changed.' + (current.status === 'applied' ? ' To undo it, change the content again (or restore a revision in WordPress).' : '')});
    }
    const item = await ctx.request('/editor-queue/' + args.post_id + '/' + args.batch_id, {namespace: NAMESPACE, method: 'POST', body: {status: 'dismissed'}});
    return ctx.result({
      ...about(pc, post),
      batch_id: args.batch_id,
      queue_status: item?.status,
      ...(item?.status !== 'dismissed' ? {warning: 'WordPress reports status ' + item?.status + '; it may have been applied in the editor at the same moment.'} : {}),
    });
  },
};
