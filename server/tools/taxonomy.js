'use strict';
// Authors, categories and tags.

const {checkCancelled} = require('../wp-client.js');
const {decode, paged, checkText} = require('../util.js');

async function listTerms(ctx, args, taxonomy) {
  const page = args.page || 1;
  const meta = {};
  const terms = await ctx.request('/' + taxonomy + '?per_page=100&page=' + page + '&search=' + encodeURIComponent(args.search || ''), {meta});
  const items = args.full ? terms : terms.map(t => ({
    id: t.id,
    name: decode(t.name),
    slug: t.slug,
    count: t.count,
    ...(taxonomy === 'categories' ? {parent: t.parent} : {}),
  }));
  return ctx.result(paged(items, page, meta, 100));
}

// Taxonomies that hold site structure, not content.
const INTERNAL_TAXONOMIES = new Set(['nav_menu', 'link_category', 'post_format', 'wp_theme', 'wp_template_part_area', 'wp_pattern_category']);
const normalize = text => decode(String(text ?? '')).replace(/\s+/g, ' ').trim();

/** REST route and shape of a taxonomy; category and post_tag need no lookup. Cached per site. */
async function resolveTaxonomy(ctx, slug) {
  if (slug === 'category') return {slug, route: '/categories', hierarchical: true};
  if (slug === 'post_tag') return {slug, route: '/tags', hierarchical: false};
  const key = ctx.site.site_url + '|' + slug;
  if (ctx.state.taxonomies.has(key)) return ctx.state.taxonomies.get(key);
  if (INTERNAL_TAXONOMIES.has(slug)) throw new Error('"' + slug + '" is a WordPress internal taxonomy and cannot be edited with this tool.');
  let tax;
  try {
    tax = await ctx.request('/taxonomies/' + encodeURIComponent(slug) + '?context=edit');
  } catch (error) {
    if (error.status !== 404) throw error;
    const all = await ctx.request('/taxonomies?context=edit');
    const available = Object.values(all).filter(t => t.rest_base && !INTERNAL_TAXONOMIES.has(t.slug)).map(t => t.slug);
    throw new Error('Site ' + ctx.site.site_id + ' has no taxonomy "' + slug + '" available over the REST API. Available: ' + available.join(', ') + '.');
  }
  if (!tax.rest_base) throw new Error('Taxonomy "' + slug + '" on site ' + ctx.site.site_id + ' is not available over the REST API.');
  const resolved = {slug, route: '/' + tax.rest_base, hierarchical: !!tax.hierarchical};
  ctx.state.taxonomies.set(key, resolved);
  return resolved;
}

function termSummary(tax, t) {
  return {
    term_id: t.id,
    taxonomy: tax.slug,
    name: decode(t.name),
    slug: t.slug,
    ...(t.description !== undefined ? {description: t.description} : {}),
    ...(tax.hierarchical ? {parent: t.parent} : {}),
    count: t.count,
    link: t.link,
    ...(t.mkt_seo ? {seo: t.mkt_seo} : {}),
  };
}

module.exports = {
  // Shared with fields.js.
  resolveTaxonomy,

  async list_terms(ctx, args) {
    const tax = await resolveTaxonomy(ctx, args.taxonomy);
    if (args.parent !== undefined && !tax.hierarchical) throw new Error('parent applies to hierarchical taxonomies (categories) only.');
    const page = args.page || 1;
    const meta = {};
    const terms = await ctx.request(tax.route + '?per_page=100&page=' + page + '&search=' + encodeURIComponent(args.search || '') + (args.parent !== undefined ? '&parent=' + args.parent : ''), {meta});
    const items = terms.map(t => {
      const {description, seo, ...rest} = termSummary(tax, t);
      return rest;
    });
    return ctx.result(paged(items, page, meta, 100));
  },

  async get_term(ctx, args) {
    const tax = await resolveTaxonomy(ctx, args.taxonomy);
    return ctx.result(termSummary(tax, await ctx.request(tax.route + '/' + args.term_id + '?context=edit')));
  },

  async update_term(ctx, args) {
    checkText(args);
    if (!args.confirm_name.trim()) throw new Error('confirm_name cannot be blank.');
    const {requireSeoPlugin, checkSeoValues} = require('./posts.js');
    const tax = await resolveTaxonomy(ctx, args.taxonomy);
    const body = {};
    for (const key of ['name', 'slug', 'description', 'parent']) if (args[key] !== undefined) body[key] = key === 'name' ? args.name.trim() : args[key];
    if (body.parent !== undefined && !tax.hierarchical) throw new Error('parent applies to hierarchical taxonomies (categories) only.');
    if (args.seo) {
      checkSeoValues(args.seo);
      await requireSeoPlugin(ctx, tax.route, args.seo, 'categories and tags');
      body.mkt_seo = args.seo;
    }
    if (!Object.keys(body).length) throw new Error('update_term needs at least one field to change (name, slug, description, parent, seo).');

    const current = await ctx.request(tax.route + '/' + args.term_id + '?context=edit');
    if (normalize(args.confirm_name) !== normalize(current.name)) {
      throw new Error('confirm_name does not match the current name of ' + tax.slug + ' term ' + args.term_id + ' on site ' + ctx.site.site_id + '. Read it with get_term and confirm the right site and term with the user.');
    }
    if (body.slug !== undefined && body.slug !== current.slug) {
      const same = await ctx.request(tax.route + '?slug=' + encodeURIComponent(body.slug));
      const other = same.find(t => t.id !== current.id);
      if (other) throw new Error('Slug ' + body.slug + ' is already used by ' + tax.slug + ' term ' + other.id + ' ("' + decode(other.name) + '"). Choose another slug.');
    }
    // Sending the name makes WordPress run its normal term save, so SEO plugins refresh their cached data.
    if (body.mkt_seo && body.name === undefined) body.name = decode(current.name);

    const saved = await ctx.request(tax.route + '/' + args.term_id, {method: 'POST', body});
    const out = termSummary(tax, saved);
    const warnings = [];
    if (args.seo && !saved.mkt_seo) warnings.push('WordPress did not confirm the SEO fields. Check them in WordPress.');
    if (body.slug !== undefined && saved.slug !== body.slug) warnings.push('WordPress saved the slug as ' + saved.slug + ' instead of ' + body.slug + '.');
    if (body.slug !== undefined && body.slug !== current.slug) warnings.push('The archive URL changed; old links to it may break unless the site redirects them.');
    return ctx.result({...out, ...(warnings.length ? {warning: warnings.join(' ')} : {})});
  },

  async list_authors(ctx, args) {
    const page = args.page || 1;
    let meta = {};
    const query = 'per_page=100&page=' + page + '&search=' + encodeURIComponent(args.search || '') + '&orderby=name';
    let users;
    try {
      users = await ctx.request('/users?context=edit&capabilities=' + encodeURIComponent('edit_posts') + '&' + query, {meta});
    } catch (error) {
      // Listing by capability needs an Administrator; Editors fall back to WordPress's older who=authors filter.
      // Other failures (bad password, server errors, timeouts) are reported as they are.
      checkCancelled(ctx.signal);
      if (![400, 403].includes(error.status) || !/^rest_/.test(error.code || '')) throw error;
      meta = {};
      users = await ctx.request('/users?who=authors&' + query, {meta});
    }
    const items = users.map(u => ({author_id: u.id, name: u.name, slug: u.slug}));
    return ctx.result(paged(items, page, meta, 100));
  },

  list_categories: (ctx, args) => listTerms(ctx, args, 'categories'),
  list_tags: (ctx, args) => listTerms(ctx, args, 'tags'),

  async create_term(ctx, args) {
    checkText(args);
    const taxonomy = args.taxonomy === 'tag' ? 'tags' : 'categories';
    const name = args.name.trim();
    if (args.parent !== undefined && taxonomy === 'tags') throw new Error('parent applies to categories only.');
    const out = (term, existing) => ctx.result({
      term_id: term.id,
      taxonomy: args.taxonomy,
      name: decode(term.name),
      slug: term.slug,
      ...(taxonomy === 'categories' ? {parent: term.parent} : {}),
      existing,
    });
    const matches = await ctx.request('/' + taxonomy + '?per_page=100&search=' + encodeURIComponent(name));
    const same = matches.find(t => decode(t.name).toLowerCase() === name.toLowerCase() || (args.slug && t.slug === args.slug));
    if (same) return out(same, true);
    const body = {
      name,
      ...(args.slug ? {slug: args.slug} : {}),
      ...(args.description ? {description: args.description} : {}),
      ...(args.parent ? {parent: args.parent} : {}),
    };
    return out(await ctx.request('/' + taxonomy, {method: 'POST', body}), false);
  },
};
