'use strict';
// Products (WooCommerce), custom post types and taxonomy terms.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {makeService} = require('../server/service.js');
const {env, mock} = require('./helpers.js');

const productType = {slug: 'product', rest_base: 'product', hierarchical: false};
const productTaxes = {product_cat: {slug: 'product_cat', rest_base: 'product_cat', hierarchical: true}, product_tag: {slug: 'product_tag', rest_base: 'product_tag', hierarchical: false}};
const productSchema = {schema: {properties: {title: {}, content: {}, excerpt: {}, slug: {}, featured_media: {}, product_cat: {}, product_tag: {}}}};

test('post types: product is resolved once per site, categories map to product_cat, preview uses post_type', async () => {
  const live = {id: 9329, type: 'product', status: 'publish', title: {raw: 'Triple Wide'}, product_cat: [16], product_tag: [], link: 'https://a.example/x/'};
  const m = mock([productType, productTaxes, productSchema, live, {...live, product_cat: [16, 17]}, {...live, status: 'draft'}]);
  const call = makeService(env, m.f);
  const r = await call('edit_published_post', {site_id: 'site-a', post_type: 'product', post_id: 9329, categories: [16, 17], excerpt: 'Short', confirm_title: 'Triple Wide', confirm_edit: true});
  assert.equal(m.calls[0].u, 'https://a.example/wp-json/wp/v2/types/product?context=edit');
  assert.equal(m.calls[1].u, 'https://a.example/wp-json/wp/v2/taxonomies?type=product&context=edit');
  assert.equal(m.calls[2].o.method, 'OPTIONS');
  assert.equal(m.calls[4].u, 'https://a.example/wp-json/wp/v2/product/9329');
  assert.deepEqual(JSON.parse(m.calls[4].o.body), {excerpt: 'Short', product_cat: [16, 17]});
  assert.deepEqual(r.data.categories, [16, 17]);
  // Cached: the next call on the same site makes no lookups.
  await call('get_post', {site_id: 'site-a', post_type: 'product', post_id: 9329});
  assert.equal(m.calls.length, 6);
  assert.match(m.calls[5].u, /\/product\/9329\?context=edit$/);
});

test('post types: custom types (QSB locations), unknown and internal types', async () => {
  const loc = {slug: 'locations', rest_base: 'locations', hierarchical: false};
  const m = mock([loc, {}, {schema: {properties: {title: {}, content: {}, slug: {}}}}, [{id: 590, type: 'locations', status: 'draft', title: {raw: 'Tennessee'}}]]);
  const r = await makeService(env, m.f)('list_posts', {site_id: 'site-a', post_type: 'locations'});
  assert.match(m.calls[3].u, /\/wp\/v2\/locations\?context=edit/);
  assert.equal(r.data.items[0].preview_url, 'https://a.example/?post_type=locations&p=590&preview=true');

  const noTax = mock([loc, {}, {schema: {properties: {title: {}, content: {}, slug: {}}}}]);
  await assert.rejects(makeService(env, noTax.f)('update_draft', {site_id: 'site-a', post_type: 'locations', post_id: 590, categories: [1]}), /has no category-style/);
  const noExcerpt = mock([loc, {}, {schema: {properties: {title: {}, content: {}, slug: {}}}}]);
  await assert.rejects(makeService(env, noExcerpt.f)('update_draft', {site_id: 'site-a', post_type: 'locations', post_id: 590, excerpt: 'x'}), /excerpt is not available for post type locations/);

  const unknown = async (u) => (u.includes('/types/nope') ? {ok: false, status: 404, json: async () => ({code: 'rest_type_invalid', message: 'Invalid post type.'})} : {ok: true, json: async () => ({post: {slug: 'post', rest_base: 'posts'}, page: {slug: 'page', rest_base: 'pages'}, product: {slug: 'product', rest_base: 'product'}, attachment: {slug: 'attachment', rest_base: 'media'}})});
  await assert.rejects(makeService(env, unknown)('get_post', {site_id: 'site-a', post_type: 'nope', post_id: 1}), /no post type "nope".*Available: post, page, product\./);
  await assert.rejects(makeService(env, mock([]).f)('get_post', {site_id: 'site-a', post_type: 'wp_template', post_id: 1}), /internal type/);
});

test('create_draft refuses new WooCommerce products (they are created in WordPress)', async () => {
  const m = mock([productType, productTaxes, productSchema]);
  await assert.rejects(makeService(env, m.f)('create_draft', {site_id: 'site-a', post_type: 'product', title: 'T', content: 'C', slug: 't'}), /Products > Add New/);
  assert(m.calls.every(c => c.o.method !== 'POST'));
});

const wcProduct = {id: 9329, name: '26x35x10 Triple Wide &amp; Carport', type: 'simple', status: 'publish', permalink: 'https://a.example/p/', sku: 'TW-1', regular_price: '9995', sale_price: '', price: '9995', on_sale: false, stock_status: 'instock', short_description: '<p>Old</p>', categories: [{id: 16, name: 'Metal Carports'}], images: [{id: 5, src: 'https://a.example/i.jpg', alt: ''}], attributes: [], variations: [], date_modified_gmt: '2026-10-21T08:00:00'};

test('update_product: WooCommerce API, name confirmation, price rules, body mapping and diff', async () => {
  const m = mock([wcProduct, {...wcProduct, sale_price: '8995', price: '8995', on_sale: true, images: [{id: 7}, {id: 5}], categories: [{id: 16}, {id: 17}]}]);
  const r = await makeService(env, m.f)('update_product', {site_id: 'site-a', product_id: 9329, sale_price: '8995', images: [7, 5], categories: [16, 17], confirm_title: '26x35x10 Triple Wide & Carport', confirm_edit: true, expected_modified_gmt: '2026-10-21T08:00:00Z'});
  assert.equal(m.calls[0].u, 'https://a.example/wp-json/wc/v3/products/9329');
  assert.equal(m.calls[1].o.method, 'PUT');
  assert.deepEqual(JSON.parse(m.calls[1].o.body), {sale_price: '8995', categories: [{id: 16}, {id: 17}], images: [{id: 7}, {id: 5}]});
  assert.deepEqual(r.data.changed.find(c => c.field === 'sale_price'), {field: 'sale_price', before: '', after: '8995'});
  assert.equal(r.data.on_sale, true);

  const refuse = async (args, re, current = wcProduct) => {
    const x = mock([current]);
    await assert.rejects(makeService(env, x.f)('update_product', {site_id: 'site-a', product_id: 9329, confirm_title: '26x35x10 Triple Wide & Carport', confirm_edit: true, ...args}), re);
    assert(x.calls.every(c => c.o.method === 'GET'), 'nothing written');
  };
  await refuse({sale_price: '9995'}, /must be lower than regular_price/);
  await refuse({regular_price: '100', sale_price: '200'}, /must be lower/);
  await refuse({regular_price: ''}, /cannot be empty/);
  await refuse({regular_price: '100', confirm_title: 'Other'}, /does not match the current name/);
  await refuse({regular_price: '100'}, /variable product/, {...wcProduct, type: 'variable'});
  await refuse({regular_price: '100', expected_modified_gmt: '2026-01-01T00:00:00'}, /changed since you read it/);
  await assert.rejects(makeService(env, mock([]).f)('update_product', {site_id: 'site-a', product_id: 1, regular_price: '$10', confirm_title: 'T', confirm_edit: true}), /plain number/);
  await assert.rejects(makeService(env, mock([]).f)('update_product', {site_id: 'site-a', product_id: 1, confirm_title: 'T', confirm_edit: true}), /at least one field/);
});

test('get_product: summary, and clear messages without WooCommerce or permission', async () => {
  const r = await makeService(env, mock([wcProduct]).f)('get_product', {site_id: 'site-a', product_id: 9329});
  assert.equal(r.data.regular_price, '9995');
  assert.deepEqual(r.data.categories, [{id: 16, name: 'Metal Carports'}]);
  const noWoo = async () => ({ok: false, status: 404, json: async () => ({code: 'rest_no_route', message: 'No route was found'})});
  await assert.rejects(makeService(env, noWoo)('get_product', {site_id: 'site-a', product_id: 1}), /Is WooCommerce active/);
  const denied = async () => ({ok: false, status: 401, json: async () => ({code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot view this resource.'})});
  await assert.rejects(makeService(env, denied)('get_product', {site_id: 'site-a', product_id: 1}), /Shop Manager or Administrator/);
});

const catTax = {slug: 'product_cat', rest_base: 'product_cat', hierarchical: true};
const term = {id: 16, name: 'Metal Carports', slug: 'metal-carports', description: '', parent: 0, count: 40, link: 'https://a.example/metal-carports/'};

test('terms: list_terms and get_term resolve product_cat; category needs no lookup', async () => {
  const m = mock([catTax, [term], term]);
  const call = makeService(env, m.f);
  const list = await call('list_terms', {site_id: 'site-a', taxonomy: 'product_cat', parent: 0});
  assert.equal(m.calls[0].u, 'https://a.example/wp-json/wp/v2/taxonomies/product_cat?context=edit');
  assert.match(m.calls[1].u, /\/product_cat\?per_page=100&page=1&search=&parent=0$/);
  assert.deepEqual(list.data.items[0], {term_id: 16, taxonomy: 'product_cat', name: 'Metal Carports', slug: 'metal-carports', parent: 0, count: 40, link: 'https://a.example/metal-carports/'});
  const one = await call('get_term', {site_id: 'site-a', taxonomy: 'product_cat', term_id: 16});
  assert.equal(m.calls.length, 3, 'taxonomy lookup cached');
  assert.equal(one.data.description, '');
  const cat = mock([{...term, id: 1}]);
  await makeService(env, cat.f)('get_term', {site_id: 'site-a', taxonomy: 'category', term_id: 1});
  assert.match(cat.calls[0].u, /\/wp\/v2\/categories\/1\?context=edit$/);
  await assert.rejects(makeService(env, mock([]).f)('list_terms', {site_id: 'site-a', taxonomy: 'nav_menu'}), /internal taxonomy/);
});

test('update_term: name confirmation, slug check, SEO through the bridge with the name re-sent', async () => {
  const bridge = {schema: {properties: {mkt_seo: {properties: {plugin: {enum: ['yoast']}, version: {enum: ['1.2.0']}, title: {}, description: {}, focus_keyword: {}, canonical: {}}}}}};
  const m = mock([catTax, bridge, term, {...term, mkt_seo: {plugin: 'yoast', title: 'Carports | AMB'}}]);
  const r = await makeService(env, m.f)('update_term', {site_id: 'site-a', taxonomy: 'product_cat', term_id: 16, seo: {title: 'Carports | AMB'}, confirm_name: 'Metal Carports', confirm_edit: true});
  assert.equal(m.calls[1].o.method, 'OPTIONS');
  assert.equal(m.calls[3].u, 'https://a.example/wp-json/wp/v2/product_cat/16');
  assert.deepEqual(JSON.parse(m.calls[3].o.body), {mkt_seo: {title: 'Carports | AMB'}, name: 'Metal Carports'}, 'name re-sent so WordPress runs a normal term save');
  assert.equal(r.data.seo.title, 'Carports | AMB');

  const desc = mock([catTax, term, [{id: 16}], {...term, description: '<p>New</p>', slug: 'carports'}]);
  const d = await makeService(env, desc.f)('update_term', {site_id: 'site-a', taxonomy: 'product_cat', term_id: 16, description: '<p>New</p>', slug: 'carports', confirm_name: 'Metal Carports', confirm_edit: true});
  assert.deepEqual(JSON.parse(desc.calls[3].o.body), {slug: 'carports', description: '<p>New</p>'});
  assert.match(d.data.warning, /archive URL changed/);

  const taken = mock([catTax, term, [{id: 99, name: 'Other'}]]);
  await assert.rejects(makeService(env, taken.f)('update_term', {site_id: 'site-a', taxonomy: 'product_cat', term_id: 16, slug: 'carports', confirm_name: 'Metal Carports', confirm_edit: true}), /already used by product_cat term 99/);
  const wrong = mock([catTax, term]);
  await assert.rejects(makeService(env, wrong.f)('update_term', {site_id: 'site-a', taxonomy: 'product_cat', term_id: 16, name: 'X', confirm_name: 'Carports', confirm_edit: true}), /does not match the current name/);
  assert(wrong.calls.every(c => c.o.method === 'GET'));
  const old = mock([catTax, {schema: {properties: {}}}]);
  await assert.rejects(makeService(env, old.f)('update_term', {site_id: 'site-a', taxonomy: 'product_cat', term_id: 16, seo: {title: 'x'}, confirm_name: 'Metal Carports', confirm_edit: true}), /categories and tags need the MKT Publisher SEO Bridge plugin.*1\.2\.0/);
  const tag = mock([{...term, id: 3}]);
  await assert.rejects(makeService(env, tag.f)('update_term', {site_id: 'site-a', taxonomy: 'post_tag', term_id: 3, parent: 1, confirm_name: 'x', confirm_edit: true}), /parent applies to hierarchical/);
});

test('create_product: always a draft simple product, full data mapped, SKU and price checks before writing', async () => {
  const created = {id: 99999, name: 'TEST Dummy Garage', slug: 'test-dummy-garage', type: 'simple', status: 'draft', regular_price: '5610', sale_price: '4999', sku: 'TEST-1', categories: [{id: 31, name: 'One Car Metal Garages'}], images: [{id: 4048}], attributes: [{name: 'Building Width', options: ['12']}], variations: []};
  const m = mock([[], created]);
  const r = await makeService(env, m.f)('create_product', {
    site_id: 'site-a', name: ' TEST Dummy Garage ', slug: 'test-dummy-garage', description: '<p>Long</p>', short_description: '<p>Short</p>',
    regular_price: '5610', sale_price: '4999', sku: 'TEST-1', stock_status: 'instock', manage_stock: true, stock_quantity: 3,
    weight: '1200', dimensions: {length: '25', width: '12', height: '10'}, categories: [243, 31], tags: [5], images: [4048],
    attributes: [{name: 'Building Width', options: ['12']}, {name: 'Color', options: ['Tan', 'White'], visible: false}],
  });
  assert.equal(m.calls[0].u, 'https://a.example/wp-json/wc/v3/products?sku=TEST-1&status=any');
  assert.equal(m.calls[1].u, 'https://a.example/wp-json/wc/v3/products');
  const body = JSON.parse(m.calls[1].o.body);
  assert.equal(body.status, 'draft');
  assert.equal(body.type, 'simple');
  assert.equal(body.name, 'TEST Dummy Garage');
  assert.deepEqual(body.categories, [{id: 243}, {id: 31}]);
  assert.deepEqual(body.images, [{id: 4048}]);
  assert.deepEqual(body.attributes[1], {name: 'Color', options: ['Tan', 'White'], visible: false, variation: false});
  assert.deepEqual(body.dimensions, {length: '25', width: '12', height: '10'});
  assert.equal(body.stock_quantity, 3);
  assert.equal(r.data.preview_url, 'https://a.example/?post_type=product&p=99999&preview=true');
  assert(!r.data.warning);

  await assert.rejects(makeService(env, mock([]).f)('create_product', {site_id: 'site-a', name: 'X', regular_price: '10', status: 'publish'}), /Unknown argument/);
  const refuse = async (args, re) => {
    const x = mock([[{id: 7, name: 'Existing'}]]);
    await assert.rejects(makeService(env, x.f)('create_product', {site_id: 'site-a', name: 'X', regular_price: '100', ...args}), re);
    assert(x.calls.every(c => c.o.method !== 'POST'), 'nothing created');
  };
  await refuse({sku: 'DMS25'}, /SKU DMS25 is already used by product 7/);
  await refuse({sale_price: '150'}, /lower than regular_price/);
  await refuse({stock_quantity: 2}, /needs manage_stock: true/);
  await refuse({attributes: [{name: 'Width'}]}, /options must be a non-empty list/);
  await refuse({name: '  '}, /name cannot be blank/);
  const wrongStatus = mock([[], {...created, status: 'publish'}]);
  const w = await makeService(env, wrongStatus.f)('create_product', {site_id: 'site-a', name: 'X', regular_price: '100', sku: 'NEW'});
  assert.match(w.data.warning, /not draft/);
});

test('post types: categories map to product_cat even when product_brand is listed first (seen on directmetalstructures.com)', async () => {
  const taxes = {
    product_brand: {slug: 'product_brand', rest_base: 'product_brand', hierarchical: true},
    product_cat: {slug: 'product_cat', rest_base: 'product_cat', hierarchical: true},
    product_tag: {slug: 'product_tag', rest_base: 'product_tag', hierarchical: false},
  };
  const draft = {id: 19810, type: 'product', status: 'draft', title: {raw: 'T'}, product_cat: [243, 31], product_brand: [], product_tag: []};
  const m = mock([productType, taxes, productSchema, draft, {...draft, product_cat: [31]}]);
  const r = await makeService(env, m.f)('update_draft', {site_id: 'site-a', post_type: 'product', post_id: 19810, categories: [31], tags: [5]});
  assert.deepEqual(JSON.parse(m.calls[4].o.body), {product_cat: [31], product_tag: [5]});
  assert.deepEqual(r.data.categories, [31]);
  const custom = mock([{slug: 'locations', rest_base: 'locations'}, {region: {slug: 'region', rest_base: 'regions', hierarchical: true}, location_cat: {slug: 'location_cat', rest_base: 'location-cats', hierarchical: true}}, {schema: {properties: {}}}, [{id: 1, type: 'locations', status: 'draft', title: {raw: 'x'}}]]);
  await makeService(env, custom.f)('list_posts', {site_id: 'site-a', post_type: 'locations'});
  const state = custom.calls.length;
  assert.equal(state, 4);
});
