'use strict';
// WooCommerce store data (price, SKU, stock, short description, gallery) through WooCommerce's own REST API (wc/v3).
// Title, long description, slug and SEO of products go through the normal post tools with post_type "product".

const {decode, checkText} = require('../util.js');

const WC = {namespace: 'wc/v3'};
const normalize = text => decode(String(text ?? '')).replace(/\s+/g, ' ').trim();

function summary(p) {
  return {
    product_id: p.id,
    name: p.name,
    type: p.type,
    status: p.status,
    permalink: p.permalink,
    sku: p.sku,
    regular_price: p.regular_price,
    sale_price: p.sale_price,
    price: p.price,
    on_sale: p.on_sale,
    stock_status: p.stock_status,
    manage_stock: p.manage_stock,
    stock_quantity: p.stock_quantity,
    short_description: p.short_description,
    categories: (p.categories || []).map(c => ({id: c.id, name: c.name})),
    images: (p.images || []).map(i => ({id: i.id, src: i.src, alt: i.alt})),
    attributes: (p.attributes || []).map(a => ({name: a.name, options: a.options})),
    variations: (p.variations || []).length,
    date_modified_gmt: p.date_modified_gmt,
  };
}

async function readProduct(ctx, productId) {
  try {
    return await ctx.request('/products/' + productId, WC);
  } catch (error) {
    if (error.status === 404 && error.code === 'rest_no_route') {
      throw new Error('The WooCommerce REST API (wc/v3) is not available on site ' + ctx.site.site_id + '. Is WooCommerce active?');
    }
    if (error.status === 401 || error.status === 403) {
      throw new Error(error.message + ' The connected account needs the Shop Manager or Administrator role on site ' + ctx.site.site_id + ' to use WooCommerce data.');
    }
    throw error;
  }
}

const number = value => (value === '' || value === undefined || value === null ? null : Number(value));

module.exports = {
  async get_product(ctx, args) {
    return ctx.result(summary(await readProduct(ctx, args.product_id)));
  },

  async update_product(ctx, args) {
    checkText(args);
    const {site_id, product_id, confirm_title, confirm_edit, expected_modified_gmt, categories, images, ...fields} = args;
    const body = {...fields};
    if (categories) body.categories = categories.map(id => ({id}));
    if (images) body.images = images.map(id => ({id}));
    if (!Object.keys(body).length) throw new Error('update_product needs at least one field to change (regular_price, sale_price, sku, stock_status, short_description, categories, images).');

    const current = await readProduct(ctx, product_id);
    if (expected_modified_gmt !== undefined) {
      const stamp = text => String(text ?? '').replace(/(?:\.\d+)?(?:Z|\+00:00)$/i, '');
      if (stamp(expected_modified_gmt) !== stamp(current.date_modified_gmt)) {
        throw new Error('Product ' + product_id + ' on site ' + ctx.site.site_id + ' changed since you read it (date_modified_gmt is now ' + current.date_modified_gmt + '). Read it again with get_product; nothing was written.');
      }
    }
    if (normalize(confirm_title) !== normalize(current.name)) {
      throw new Error('confirm_title does not match the current name of product ' + product_id + ' on site ' + ctx.site.site_id + '. Read it with get_product and confirm the right site and product with the user.');
    }
    if (('regular_price' in body || 'sale_price' in body) && current.type === 'variable') {
      throw new Error('Product ' + product_id + ' is a variable product; its prices are set per variation in WordPress (Products > Edit > Variations). Nothing was written.');
    }
    if ('regular_price' in body && body.regular_price === '') throw new Error('regular_price cannot be empty; a product without a price cannot be bought.');
    const regular = number('regular_price' in body ? body.regular_price : current.regular_price);
    const sale = number('sale_price' in body ? body.sale_price : current.sale_price);
    if (sale !== null && regular !== null && sale >= regular) {
      throw new Error('sale_price (' + sale + ') must be lower than regular_price (' + regular + '). Nothing was written.');
    }

    const updated = await ctx.request('/products/' + product_id, {...WC, method: 'PUT', body});
    const after = summary(updated);
    const before = summary(current);
    const changed = Object.keys(body).map(key => ({field: key, before: before[key], after: after[key]}));
    const warnings = [];
    if ('regular_price' in body && String(after.regular_price) !== String(body.regular_price)) warnings.push('WooCommerce saved regular_price as ' + after.regular_price + '.');
    if ('sale_price' in body && String(after.sale_price) !== String(body.sale_price)) warnings.push('WooCommerce saved sale_price as ' + after.sale_price + ' (a scheduled sale may apply).');
    return ctx.result({...after, changed, ...(warnings.length ? {warning: warnings.join(' ')} : {})});
  },
};
