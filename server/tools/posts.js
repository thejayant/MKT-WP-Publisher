'use strict';
// Posts, pages and other post types (WooCommerce products, custom post types): listing, reading, drafts, block-safe
// edits, publishing and scheduling.

const {markdownToHtml} = require('../markdown.js');
const {outline, applyChanges} = require('../blocks.js');
const {raw, paged, checkText} = require('../util.js');

const ALL_STATUSES = 'draft,pending,future,publish,private';
const EDITABLE_STATUSES = ['draft', 'pending', 'future', 'publish', 'private'];
const ISO_WITH_ZONE = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/i;
const MIN_SCHEDULE_AHEAD_MS = 2 * 60 * 1000;
const MAX_SCHEDULE_AHEAD_MS = 2 * 366 * 86400000;
// WordPress internals that are not content and must never be edited through this tool.
const INTERNAL_TYPES = new Set(['attachment', 'nav_menu_item', 'wp_block', 'wp_template', 'wp_template_part', 'wp_global_styles', 'wp_navigation', 'wp_font_family', 'wp_font_face', 'revision', 'customize_changeset', 'oembed_cache', 'user_request', 'wp_changeset', 'custom_css']);

const normalize = text => String(text ?? '').replace(/\s+/g, ' ').trim();

/** Built-in types need no lookups, so existing calls make exactly the same requests as before. */
function builtInType(slug) {
  if (slug === 'page') return {slug: 'page', route: '/pages', kind: 'page', isPage: true, hierarchical: true};
  if (slug === 'post') return {slug: 'post', route: '/posts', kind: 'post', isPage: false, hierarchical: false, taxonomyMap: {categories: 'categories', tags: 'tags'}};
  return null;
}

/**
 * Other post types (product, locations, …): look up the REST route, the type's own taxonomies (so "categories" means
 * product_cat on products) and the fields its schema accepts. Cached per site for the life of the server.
 */
async function resolveType(ctx, slug) {
  const key = ctx.site.site_url + '|' + slug;
  if (ctx.state.postTypes.has(key)) return ctx.state.postTypes.get(key);
  if (INTERNAL_TYPES.has(slug)) throw new Error('"' + slug + '" is a WordPress internal type and cannot be edited with this tool.');
  let type;
  try {
    type = await ctx.request('/types/' + encodeURIComponent(slug) + '?context=edit');
  } catch (error) {
    if (error.status !== 404) throw error;
    const all = await ctx.request('/types?context=edit');
    const available = Object.values(all).filter(t => t.rest_base && !INTERNAL_TYPES.has(t.slug)).map(t => t.slug);
    throw new Error('Site ' + ctx.site.site_id + ' has no post type "' + slug + '" available over the REST API. Available: ' + available.join(', ') + '.');
  }
  if (!type.rest_base) throw new Error('Post type "' + slug + '" on site ' + ctx.site.site_id + ' is not available over the REST API.');
  const route = '/' + type.rest_base;
  const taxonomies = await ctx.request('/taxonomies?type=' + encodeURIComponent(slug) + '&context=edit');
  const list = Object.values(taxonomies || {}).filter(t => t.rest_base);
  // Prefer the well-known names: WooCommerce sites can list product_brand (also hierarchical) before product_cat,
  // so "first hierarchical taxonomy" would point categories at brands.
  const pick = hierarchical => {
    const kind = list.filter(t => !!t.hierarchical === hierarchical);
    const known = hierarchical ? ['product_cat', 'category'] : ['product_tag', 'post_tag'];
    const pattern = hierarchical ? /(?:^|_)(?:cat|category|categories)$/ : /(?:^|_)tags?$/;
    const best = kind.find(t => known.includes(t.slug)) || kind.find(t => pattern.test(t.slug || '')) || kind[0];
    return best && best.rest_base;
  };
  const schema = await ctx.request(route, {method: 'OPTIONS'});
  const resolved = {
    slug,
    route,
    kind: slug,
    isPage: false,
    hierarchical: !!type.hierarchical,
    taxonomyMap: {categories: pick(true), tags: pick(false)},
    props: new Set(Object.keys(schema?.schema?.properties || {})),
  };
  ctx.state.postTypes.set(key, resolved);
  return resolved;
}

/** Per-call helpers that depend on the selected site and post type. */
async function postContext(ctx, args) {
  const type = builtInType(args.post_type || 'post') || await resolveType(ctx, args.post_type);
  const {isPage, route, kind} = type;
  const custom = !builtInType(type.slug);
  const preview = p => {
    if (p.status === 'publish' || !Number.isSafeInteger(p.id)) return {};
    const query = custom ? 'post_type=' + type.slug + '&p=' + p.id : (p.type === 'page' || isPage ? 'page_id' : 'p') + '=' + p.id;
    return {preview_url: ctx.site.site_url + '/?' + query + '&preview=true'};
  };
  const taxonomyFields = p => {
    if (isPage) return {parent: p.parent};
    const map = type.taxonomyMap || {};
    const out = {};
    if (map.categories && p[map.categories] !== undefined) out.categories = p[map.categories];
    if (custom && map.tags && p[map.tags] !== undefined) out.tags = p[map.tags];
    if (custom && type.hierarchical) out.parent = p.parent;
    return out;
  };
  const summarize = p => ({
    post_id: p.id,
    ...(p.type ? {post_type: p.type} : {}),
    status: p.status,
    url: p.link,
    slug: p.slug,
    title: p.title,
    author: p.author,
    featured_media: p.featured_media,
    ...taxonomyFields(p),
    ...(p.mkt_seo ? {seo: p.mkt_seo} : {}),
    ...preview(p),
  });
  return {...type, custom, preview, summarize};
}

/**
 * The SEO Bridge plugin advertises the active SEO plugin (and, from 1.1.0, its version and fields) in the endpoint
 * schema (OPTIONS), so this runs before any write that includes seo. A positive answer is cached per site and route.
 */
// Fields every bridge version supports; newer fields are checked against the site's bridge schema.
const BASE_SEO_FIELDS = ['title', 'description', 'focus_keyword'];

async function requireSeoPlugin(ctx, route, seo, what = 'posts and pages') {
  const key = ctx.site.site_url + route;
  let bridge = ctx.state.seoPlugins.get(key);
  if (!bridge) {
    const schema = await ctx.request(route, {method: 'OPTIONS'});
    const props = schema?.schema?.properties?.mkt_seo?.properties;
    const plugin = props?.plugin?.enum?.[0];
    if (!plugin) {
      throw new Error('SEO fields for ' + what + ' need the MKT Publisher SEO Bridge plugin on site ' + ctx.site.site_id + (what === 'posts and pages' ? '' : ' (version 1.2.0 or later)') + '. Install or update it in WordPress (Plugins > Add New > Upload), then retry. Nothing was saved.');
    }
    if (plugin === 'none') throw new Error('Site ' + ctx.site.site_id + ' has the SEO Bridge plugin but neither Yoast SEO nor Rank Math is active. Nothing was saved.');
    bridge = {plugin, version: props.version?.enum?.[0] || '1.0.0', fields: new Set([...BASE_SEO_FIELDS, ...Object.keys(props)])};
    ctx.state.seoPlugins.set(key, bridge);
  }
  const unsupported = Object.keys(seo).filter(field => !bridge.fields.has(field));
  if (unsupported.length) {
    throw new Error('The SEO Bridge plugin on site ' + ctx.site.site_id + ' (version ' + bridge.version + ') does not support ' + unsupported.join(', ') + '. Update it to version 1.1.0 or later (upload the new zip and choose Replace current with uploaded). Nothing was saved.');
  }
  return bridge.plugin;
}

function checkSeoValues(seo) {
  if (seo.canonical !== undefined && seo.canonical !== '' && !/^https?:\/\/\S+$/i.test(seo.canonical)) {
    throw new Error('seo.canonical must be a full http:// or https:// URL, or empty to remove it.');
  }
}

/** Field rules for one post type, then the WordPress body (with categories/tags mapped to the type's taxonomies). */
function mapFields(pc, args, body) {
  if (pc.isPage) {
    for (const key of ['categories', 'tags', 'excerpt']) {
      if (Object.hasOwn(args, key)) throw new Error(key + ' applies to posts only; pages do not have it.');
    }
    return;
  }
  if (!pc.custom) {
    if (Object.hasOwn(args, 'parent')) throw new Error('parent applies to pages only.');
    return;
  }
  for (const key of ['categories', 'tags']) {
    if (!Object.hasOwn(body, key)) continue;
    const field = pc.taxonomyMap[key];
    if (!field) throw new Error('Post type ' + pc.slug + ' has no ' + (key === 'categories' ? 'category-style (hierarchical)' : 'tag-style') + ' taxonomy.');
    body[field] = body[key];
    if (field !== key) delete body[key];
  }
  for (const key of ['excerpt', 'parent', 'author', 'featured_media', 'title', 'content', 'slug']) {
    if (Object.hasOwn(body, key) && !pc.props.has(key)) throw new Error(key + ' is not available for post type ' + pc.slug + '.');
  }
}

/**
 * Validate and prepare the WordPress body for create_draft/update_draft (and run the shared checks for
 * publish_post/schedule_post). Returns the body plus a function that summarises the write response.
 */
async function prepareWrite(ctx, args, pc) {
  checkText(args);
  const {site_id, post_id, post_type, confirm_title, confirm_publish, confirm_schedule, confirm_edit, confirm_unpublish, publish_at, publish_date, content_format, seo, expected_modified_gmt, changes, ...body} = args;
  mapFields(pc, args, body);
  if (content_format !== undefined && body.content === undefined) throw new Error('content_format needs content.');
  if (content_format === 'markdown') body.content = markdownToHtml(body.content);
  if (seo) {
    checkSeoValues(seo);
    await requireSeoPlugin(ctx, pc.route, seo, pc.custom ? pc.slug + ' items' : 'posts and pages');
    body.mkt_seo = seo;
  }
  // Report SEO values from the write response; warn if WordPress did not return them.
  const written = p => {
    const out = pc.summarize(p);
    return seo && !p.mkt_seo ? {...out, warning: 'WordPress did not confirm the SEO fields. Check them in WordPress.'} : out;
  };
  return {body, written};
}

/**
 * Read the post before a write. With expected_modified_gmt, refuse if someone changed it in WordPress since the
 * caller read it. This narrows (but cannot close) the gap between this read and the write that follows.
 */
async function readCurrent(ctx, args, pc) {
  const current = await ctx.request(pc.route + '/' + args.post_id + '?context=edit');
  if (args.expected_modified_gmt !== undefined) {
    const stamp = text => String(text ?? '').replace(/(?:\.\d+)?(?:Z|\+00:00)$/i, '');
    if (stamp(args.expected_modified_gmt) !== stamp(current.modified_gmt)) {
      throw new Error(pc.kind[0].toUpperCase() + pc.kind.slice(1) + ' ' + args.post_id + ' on site ' + ctx.site.site_id + ' changed since you read it (modified_gmt is now ' + current.modified_gmt + '). Read it again with get_post and check the changes with the user; nothing was written.');
    }
  }
  return current;
}

/** A requested slug must not belong to another post of the same type (WordPress would quietly add -2). */
async function requireFreeSlug(ctx, pc, slug, ownId) {
  const existing = await ctx.request(pc.route + '?context=edit&slug=' + encodeURIComponent(slug) + '&status=' + ALL_STATUSES);
  const other = existing.find(p => p.id !== ownId);
  if (other) throw new Error('Slug already exists on site ' + ctx.site.site_id + ' at ' + pc.kind + ' ID ' + other.id + '. ' + (ownId ? 'Choose another slug.' : 'Read or update that ' + pc.kind + ' instead.'));
}

/** Parse an ISO 8601 date-time that carries a timezone; returns epoch ms. */
function parseZoned(value, name, example) {
  if (!ISO_WITH_ZONE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(name + ' must be an ISO 8601 date-time with a timezone, for example ' + example + '.');
  }
  return Date.parse(value);
}

/** A back date (or now) for publishing: not in the future, so WordPress publishes instead of scheduling. */
function pastDateGmt(value) {
  const when = parseZoned(value, 'publish_date', '2025-03-01T10:00:00+05:30');
  if (when > Date.now() + 60000) throw new Error('publish_date must be now or in the past. To publish later, use schedule_post.');
  if (when < Date.UTC(1990, 0, 1)) throw new Error('publish_date is too far in the past.');
  // WordPress takes date_gmt without a zone suffix.
  return new Date(when).toISOString().slice(0, 19);
}

/** Shared by update_draft and edit_published_post: validate, check status and slug, write, report. */
async function updateExisting(ctx, args, {statuses, toolName, live}) {
  const pc = await postContext(ctx, args);
  const {body, written} = await prepareWrite(ctx, args, pc);
  if (live && args.publish_date !== undefined) body.date_gmt = pastDateGmt(args.publish_date);
  if (!Object.keys(body).length) {
    throw new Error(toolName + ' needs at least one field to change (title, content, slug, excerpt, categories, tags, featured_media, author, parent, seo' + (live ? ', publish_date' : '') + ').');
  }
  const current = await readCurrent(ctx, args, pc);
  if (!statuses.includes(current.status)) {
    const hint = live ? ' Use update_draft for drafts, pending and scheduled ' + pc.kind + 's.' : ' To change a published ' + pc.kind + ', use edit_published_post.';
    throw new Error(toolName + ' works on ' + statuses.join('/') + ' ' + pc.kind + 's only; this one is ' + current.status + '.' + hint);
  }
  if (live) requireTitle(ctx, args, pc, current);
  if (body.slug !== undefined && body.slug !== current.slug) await requireFreeSlug(ctx, pc, body.slug, current.id);
  const out = written(await ctx.request(pc.route + '/' + args.post_id, {method: 'POST', body}));
  const warnings = [out.warning];
  if (body.slug !== undefined && out.slug !== undefined && out.slug !== body.slug) warnings.push('WordPress saved the slug as ' + out.slug + ' instead of ' + body.slug + '.');
  if (out.status !== undefined && out.status !== current.status) warnings.push('Its status changed from ' + current.status + ' to ' + out.status + '. Check the ' + pc.kind + ' in WordPress.');
  if (live && body.slug !== undefined && body.slug !== current.slug) warnings.push('The public URL changed; old links to it may break unless the site redirects them.');
  const warning = warnings.filter(Boolean).join(' ');
  return ctx.result(warning ? {...out, warning} : out);
}

function requireTitle(ctx, args, pc, current) {
  if (normalize(args.confirm_title) !== normalize(raw(current.title))) {
    throw new Error('confirm_title does not match the current title of ' + pc.kind + ' ' + args.post_id + ' on site ' + ctx.site.site_id + '. Read the ' + pc.kind + ' with get_post and confirm the right site and ' + pc.kind + ' with the user.');
  }
}

/** The stored content with block markup. Needs an account that can edit the post (context=edit). */
function rawContent(ctx, pc, post) {
  const content = post?.content?.raw;
  if (typeof content !== 'string') {
    throw new Error('WordPress did not return the stored content of ' + pc.kind + ' ' + post?.id + ' on site ' + ctx.site.site_id + '. The connected account needs permission to edit it.');
  }
  return content;
}

module.exports = {
  postContext,

  async list_posts(ctx, args) {
    const pc = await postContext(ctx, args);
    const page = args.page || 1;
    const meta = {};
    const status = args.status === 'all' ? ALL_STATUSES : args.status || 'draft,pending';
    const posts = await ctx.request(pc.route + '?context=edit&per_page=50&page=' + page + '&status=' + status + '&orderby=modified&order=desc&search=' + encodeURIComponent(args.search || '') + '&_fields=id,type,status,link,slug,title,author,modified_gmt', {meta});
    const items = posts.map(p => ({
      post_id: p.id,
      ...(p.type ? {post_type: p.type} : {}),
      status: p.status,
      title: raw(p.title),
      slug: p.slug,
      url: p.link,
      author: p.author,
      modified_gmt: p.modified_gmt,
      ...pc.preview(p),
    }));
    return ctx.result(paged(items, page, meta, 50));
  },

  async get_post(ctx, args) {
    const pc = await postContext(ctx, args);
    const p = await ctx.request(pc.route + '/' + args.post_id + '?context=edit');
    if (args.full) return ctx.result(p);
    const hasExcerpt = pc.custom ? pc.props.has('excerpt') : !pc.isPage;
    return ctx.result({
      ...pc.summarize(p),
      title: raw(p.title),
      ...(hasExcerpt ? {excerpt: raw(p.excerpt)} : {}),
      ...(!pc.isPage && !pc.custom ? {tags: p.tags} : {}),
      content: raw(p.content),
      date_gmt: p.date_gmt,
      modified_gmt: p.modified_gmt,
    });
  },

  async create_draft(ctx, args) {
    const pc = await postContext(ctx, args);
    if (pc.slug === 'product') throw new Error('Create new WooCommerce products in WordPress (Products > Add New), so price and stock are set up correctly; then edit them here with update_product, update_draft or edit_published_post.');
    const {body, written} = await prepareWrite(ctx, args, pc);
    await requireFreeSlug(ctx, pc, args.slug);
    return ctx.result(written(await ctx.request(pc.route, {method: 'POST', body: {...body, status: 'draft'}})));
  },

  // Drafts, pending and scheduled posts. A scheduled post keeps its publish time.
  update_draft: (ctx, args) => updateExisting(ctx, args, {statuses: ['draft', 'pending', 'future'], toolName: 'update_draft', live: false}),

  // Live posts: changes are public at once, so the current title must be confirmed (like publish_post).
  edit_published_post: (ctx, args) => updateExisting(ctx, args, {statuses: ['publish', 'private'], toolName: 'edit_published_post', live: true}),

  /** Numbered outline of the blocks in a post, with each block's text or ACF fields. Read-only. */
  async list_blocks(ctx, args) {
    const pc = await postContext(ctx, args);
    const p = await ctx.request(pc.route + '/' + args.post_id + '?context=edit');
    const content = rawContent(ctx, pc, p);
    return ctx.result({
      post_id: p.id,
      ...(p.type ? {post_type: p.type} : {}),
      status: p.status,
      title: raw(p.title),
      modified_gmt: p.modified_gmt,
      uses_blocks: content.includes('<!-- wp:'),
      ...outline(content),
    });
  },

  /** Change text inside specific blocks (or ACF block fields), keeping every other byte of the content. */
  async edit_blocks(ctx, args) {
    const pc = await postContext(ctx, args);
    checkText(args);
    const current = await readCurrent(ctx, args, pc);
    requireTitle(ctx, args, pc, current);
    if (!EDITABLE_STATUSES.includes(current.status)) throw new Error('edit_blocks works on draft, pending, scheduled, published or private ' + pc.kind + 's; this one is ' + current.status + '.');
    const before = rawContent(ctx, pc, current);
    const {content, diff, edits} = applyChanges(before, args.changes);
    if (content === before) throw new Error('The changes leave the content exactly as it is. Nothing was saved.');
    const saved = await ctx.request(pc.route + '/' + args.post_id, {method: 'POST', body: {content}});
    const warnings = [];
    if (typeof saved?.content?.raw === 'string' && saved.content.raw !== content) {
      warnings.push('WordPress changed the content while saving (for example it removed HTML this account may not post). Review the ' + pc.kind + ' in WordPress.');
    }
    if (saved?.status && saved.status !== current.status) warnings.push('Its status changed from ' + current.status + ' to ' + saved.status + '.');
    return ctx.result({
      ...pc.summarize(saved),
      changes: diff,
      edits,
      live: current.status === 'publish',
      undo: 'WordPress keeps the previous version in Revisions (open the ' + pc.kind + ' in the editor > Revisions) for post types with revisions.',
      ...(warnings.length ? {warning: warnings.join(' ')} : {}),
    });
  },

  async unpublish_post(ctx, args) {
    const pc = await postContext(ctx, args);
    await prepareWrite(ctx, args, pc);
    const current = await readCurrent(ctx, args, pc);
    requireTitle(ctx, args, pc, current);
    if (current.status === 'draft') return ctx.result(pc.summarize(current));
    if (!['publish', 'private', 'future', 'pending'].includes(current.status)) {
      throw new Error('unpublish_post works on published, private, scheduled or pending ' + pc.kind + 's; this one is ' + current.status + '.');
    }
    const out = pc.summarize(await ctx.request(pc.route + '/' + args.post_id, {method: 'POST', body: {status: 'draft'}}));
    const notes = [];
    if (out.status !== 'draft') notes.push('WordPress returned status ' + out.status + ', not draft. Check the ' + pc.kind + ' in WordPress.');
    if (current.status === 'future') notes.push('It keeps its future date: use schedule_post to schedule it again, or publish_post with publish_date to publish it now.');
    return ctx.result({...out, previous_status: current.status, ...(notes.length ? {warning: notes.join(' ')} : {})});
  },

  async publish_post(ctx, args) {
    const pc = await postContext(ctx, args);
    await prepareWrite(ctx, args, pc);
    const current = await readCurrent(ctx, args, pc);
    requireTitle(ctx, args, pc, current);
    if (current.status === 'publish') {
      if (args.publish_date !== undefined) throw new Error('This ' + pc.kind + ' is already published. To change its date, use edit_published_post with publish_date.');
      return ctx.result(pc.summarize(current));
    }
    if (!['draft', 'pending'].includes(current.status)) throw new Error('Only draft or pending ' + pc.kind + 's can be published with this tool.');
    // publish_date back-dates the post (or sets it to now); without it the post's own date must not be in the future.
    const date_gmt = args.publish_date !== undefined ? pastDateGmt(args.publish_date) : undefined;
    const dateGmt = current.date_gmt;
    const when = typeof dateGmt === 'string' ? Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(dateGmt) ? dateGmt : dateGmt + 'Z') : NaN;
    if (date_gmt === undefined && when > Date.now() + 60000) {
      throw new Error('Post ' + args.post_id + ' on site ' + ctx.site.site_id + ' has a future date (' + dateGmt + ' GMT), so WordPress would schedule it instead of publishing. Use schedule_post to schedule it for that time, or publish_post with publish_date (now or earlier) to publish it now.');
    }
    const published = pc.summarize(await ctx.request(pc.route + '/' + args.post_id, {method: 'POST', body: {status: 'publish', ...(date_gmt ? {date_gmt} : {})}}));
    const out = date_gmt ? {...published, published_at_gmt: date_gmt + 'Z'} : published;
    if (published.status === 'publish') return ctx.result(out);
    return ctx.result({...out, warning: 'WordPress returned status ' + published.status + ', not publish. Check the ' + pc.kind + ' in WordPress.'});
  },

  async schedule_post(ctx, args) {
    const pc = await postContext(ctx, args);
    await prepareWrite(ctx, args, pc);
    const current = await readCurrent(ctx, args, pc);
    requireTitle(ctx, args, pc, current);
    const when = parseZoned(args.publish_at, 'publish_at', '2026-11-02T09:00:00+05:30 or 2026-11-02T03:30:00Z');
    if (when < Date.now() + MIN_SCHEDULE_AHEAD_MS) throw new Error('publish_at must be at least 2 minutes in the future. To publish now, use publish_post.');
    if (when > Date.now() + MAX_SCHEDULE_AHEAD_MS) throw new Error('publish_at must be within 2 years.');
    if (!['draft', 'pending', 'future'].includes(current.status)) {
      throw new Error('Only draft, pending or scheduled ' + pc.kind + 's can be scheduled with this tool (this one is ' + current.status + ').');
    }
    // WordPress takes date_gmt without a zone suffix.
    const date_gmt = new Date(when).toISOString().slice(0, 19);
    const scheduled = pc.summarize(await ctx.request(pc.route + '/' + args.post_id, {method: 'POST', body: {status: 'future', date_gmt}}));
    const out = {...scheduled, publish_at_gmt: date_gmt + 'Z'};
    if (scheduled.status === 'future') return ctx.result(out);
    return ctx.result({...out, warning: 'WordPress returned status ' + scheduled.status + ', not future. Check the ' + pc.kind + ' in WordPress.'});
  },

  // Shared with taxonomy.js (term SEO uses the same bridge check).
  requireSeoPlugin,
  checkSeoValues,
};
