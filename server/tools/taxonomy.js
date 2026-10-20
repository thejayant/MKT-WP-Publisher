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

module.exports = {
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
