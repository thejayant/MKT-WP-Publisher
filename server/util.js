'use strict';

const {SLUG} = require('./constants.js');

/** WordPress returns many text fields as {raw, rendered}; prefer the raw value. */
const raw = field => (typeof field === 'object' && field ? field.raw ?? field.rendered : field);

/** Decode the few HTML entities WordPress uses in term names. */
const decode = text => String(text ?? '')
  .replace(/&#0?39;/g, '\'')
  .replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

/** Paging envelope. has_more uses WordPress's total_pages header when sent, else a full page. */
const paged = (items, page, meta, size) => ({
  items,
  page,
  ...meta,
  has_more: meta.total_pages === undefined ? items.length === size : page < meta.total_pages,
});

/** Reject blank text fields and malformed slugs before any request is made. */
function checkText(args) {
  for (const key of ['title', 'content', 'slug', 'confirm_title', 'name']) {
    if (Object.hasOwn(args, key) && !args[key].trim()) throw new Error(key + ' cannot be blank.');
  }
  if (args.slug !== undefined && !SLUG.test(args.slug)) throw new Error('Use lowercase letters, digits, and single hyphens for the slug.');
}

module.exports = {raw, decode, paged, checkText};
