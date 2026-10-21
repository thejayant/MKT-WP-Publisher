'use strict';
// inspect_fields / update_fields: custom fields through SEO Bridge 1.3 ("mkt_fields").
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {makeService} = require('../server/service.js');
const {env, mock} = require('./helpers.js');

const bridge = {schema: {properties: {mkt_fields: {properties: {source: {enum: ['acf']}, version: {enum: ['1.3.0']}}}}}};
const text = (label, type = 'text') => ({key: 'field_' + label, label, type, writable: true});
const rowsDef = {key: 'field_rows', label: 'Rows', type: 'repeater', writable: true, sub_fields: {'2_column_content_text': text('t', 'wysiwyg'), '2_column_content_image': text('i', 'image')}};
// What SEO Bridge 1.3 returns for a Safeway-style page (values keyed by name; PHP sends empty objects as []).
const fieldsData = () => ({
  source: 'acf',
  version: '1.3.0',
  acf_version: '6.3.5',
  fields: {
    hero_title: {...text('Hero title'), value: 'Steel Buildings Virginia'},
    note: {key: 'field_note', label: 'Note', type: 'message', writable: false, value: null},
    hero_image: {...text('Hero image', 'image'), value: '77'},
    cta: {key: 'field_cta', label: 'CTA', type: 'group', writable: true, sub_fields: {label: text('Label'), link: text('Link', 'url')}, value: {label: 'Call us', link: 'https://s.example/contact/'}},
    faqs: {key: 'field_faqs', label: 'FAQs', type: 'repeater', writable: true, sub_fields: {question: text('Q'), answer: text('A', 'textarea')}, value: [{question: 'Q1', answer: 'A1'}, {question: 'Q2', answer: 'A2'}]},
    full_page_content: {
      key: 'field_fpc', label: 'Full page content', type: 'flexible_content', writable: true,
      layouts: {'2_column_content': {label: '2 column content', sub_fields: {'2_column_content_row': rowsDef}}},
      value: [
        {acf_fc_layout: '2_column_content', '2_column_content_row': [{'2_column_content_text': '<p>Row 0</p>', '2_column_content_image': '77'}]},
        {acf_fc_layout: '2_column_content', '2_column_content_row': [{'2_column_content_text': '<p>Our Virginia buildings are built tough.</p>', '2_column_content_image': '78'}]},
      ],
    },
  },
  meta: {city_intro: {value: 'Old intro', writable: true}, state_faq: {value: {q: 1}, writable: false}},
});
const page = (data = fieldsData()) => ({id: 2549, type: 'page', status: 'publish', title: {raw: 'Virginia'}, link: 'https://s.example/virginia/', modified_gmt: '2026-10-20T10:00:00', mkt_fields: data});
const confirm = {confirm_title: 'Virginia', confirm_edit: true};

test('inspect_fields: bridge check, read with ?mkt_fields=1, flat paths for every value', async () => {
  const m = mock([bridge, page()]);
  const r = await makeService(env, m.f)('inspect_fields', {site_id: 'site-a', post_type: 'page', post_id: 2549});
  assert.equal(m.calls[0].o.method, 'OPTIONS');
  assert.equal(m.calls[0].u, 'https://a.example/wp-json/wp/v2/pages');
  assert.equal(m.calls[1].u, 'https://a.example/wp-json/wp/v2/pages/2549?context=edit&mkt_fields=1');
  assert.equal(r.data.source, 'acf');
  assert.equal(r.data.bridge_version, '1.3.0');
  const paths = Object.fromEntries(r.data.paths.map(p => [p.path, p]));
  assert.equal(paths.hero_title.value, 'Steel Buildings Virginia');
  assert.equal(paths.note.writable, false);
  assert.equal(paths['cta.label'].value, 'Call us');
  assert.equal(paths['faqs[1].answer'].type, 'textarea');
  assert.equal(paths['full_page_content[1].2_column_content_row[0].2_column_content_text'].value, 'Our Virginia buildings are built tough.', 'HTML stripped in the preview');
  assert.equal(r.data.fields.faqs.value.length, 2, 'full values are included too');

  const none = mock([bridge, page({source: 'acf', version: '1.3.0', fields: [], meta: []})]);
  const n = await makeService(env, none.f)('inspect_fields', {site_id: 'site-a', post_type: 'page', post_id: 2549});
  assert.match(n.data.note, /No Advanced Custom Fields field group.*list_blocks/);
});

test('inspect_fields: clear errors for an old bridge, missing permission and bad targets', async () => {
  const old = mock([{schema: {properties: {mkt_seo: {properties: {version: {enum: ['1.2.2']}}}}}}]);
  await assert.rejects(makeService(env, old.f)('inspect_fields', {site_id: 'site-a', post_type: 'page', post_id: 1}), /SEO Bridge 1\.3\.0 or later on site site-a \(it has 1\.2\.2\).*Nothing was changed/);
  const missing = mock([{schema: {properties: {}}}]);
  await assert.rejects(makeService(env, missing.f)('inspect_fields', {site_id: 'site-a', post_id: 1}), /\(it is not installed\)/);
  const denied = mock([bridge, {id: 1, title: {raw: 'x'}, mkt_fields: null}]);
  await assert.rejects(makeService(env, denied.f)('inspect_fields', {site_id: 'site-a', post_id: 1}), /needs permission to edit it/);
  await assert.rejects(makeService(env, mock([]).f)('inspect_fields', {site_id: 'site-a'}), /Pass post_id/);
  await assert.rejects(makeService(env, mock([]).f)('inspect_fields', {site_id: 'site-a', post_id: 1, term_id: 2, taxonomy: 'category'}), /not both/);
  await assert.rejects(makeService(env, mock([]).f)('inspect_fields', {site_id: 'site-a', term_id: 2}), /needs both taxonomy and term_id/);
});

test('update_fields: a nested flexible content row changes, everything else is sent back as stored', async () => {
  const after = fieldsData();
  after.fields.full_page_content.value[1]['2_column_content_row'][0]['2_column_content_text'] = '<p>Our Virginia buildings are built for snow.</p>';
  after.fields.faqs.value[1].answer = 'New A2';
  const m = mock([bridge, page(), page(after)]);
  const r = await makeService(env, m.f)('update_fields', {
    site_id: 'site-a', post_type: 'page', post_id: 2549, ...confirm, expected_modified_gmt: '2026-10-20T10:00:00Z',
    changes: [
      {path: 'full_page_content[1].2_column_content_row[0].2_column_content_text', replace_text: {find: 'built tough', with: 'built for snow'}},
      {path: 'faqs[1].answer', value: 'New A2'},
    ],
  });
  assert.equal(m.calls[2].u, 'https://a.example/wp-json/wp/v2/pages/2549');
  assert.equal(m.calls[2].o.method, 'POST');
  const sent = JSON.parse(m.calls[2].o.body).mkt_fields.fields;
  assert.deepEqual(Object.keys(sent), ['full_page_content', 'faqs'], 'only the changed top-level fields are sent');
  assert.deepEqual(sent.full_page_content, after.fields.full_page_content.value, 'other rows, images and layouts are sent back unchanged');
  assert.deepEqual(sent.faqs, [{question: 'Q1', answer: 'A1'}, {question: 'Q2', answer: 'New A2'}]);
  assert.deepEqual(r.data.changes[0], {path: 'full_page_content[1].2_column_content_row[0].2_column_content_text', before: '<p>Our Virginia buildings are built tough.</p>', after: '<p>Our Virginia buildings are built for snow.</p>'});
  assert.equal(r.data.live, true);
  assert.deepEqual(r.data.restore.changes.map(c => c.path), ['full_page_content', 'faqs']);
  assert.deepEqual(r.data.restore.changes[1].value, fieldsData().fields.faqs.value, 'restore holds the previous values');
  assert(!r.data.warning);
});

test('update_fields: groups, whole rows, meta, and a warning when WordPress stores something else', async () => {
  const stored = fieldsData();
  stored.fields.cta.value.label = 'Get a quote';
  stored.fields.faqs.value[0] = {question: 'New Q1', answer: 'A1'};
  stored.meta.city_intro.value = 'New intro'; // WordPress filtered the <script> out
  const m = mock([bridge, page(), page(stored)]);
  const r = await makeService(env, m.f)('update_fields', {
    site_id: 'site-a', post_type: 'page', post_id: 2549, ...confirm,
    changes: [{path: 'cta.label', value: 'Get a quote'}, {path: 'faqs[0]', value: {question: 'New Q1'}}, {meta: 'city_intro', value: 'New intro<script>x</script>'}, {path: 'hero_image', value: 77}],
  });
  const body = JSON.parse(m.calls[2].o.body).mkt_fields;
  assert.deepEqual(body.fields.cta, {label: 'Get a quote', link: 'https://s.example/contact/'});
  assert.deepEqual(body.fields.faqs[0], {question: 'New Q1', answer: 'A1'}, 'a row object merges into the row');
  assert.equal(body.fields.hero_image, 77);
  assert.deepEqual(body.meta, {city_intro: 'New intro<script>x</script>'});
  assert.match(r.data.warning, /stored city_intro differently/);
  assert.deepEqual(r.data.restore.changes.find(c => c.meta), {meta: 'city_intro', value: 'Old intro'});
});

test('update_fields: refused before anything is written', async () => {
  const refuse = async (changes, re, extra = {}, current = page()) => {
    const m = mock([bridge, current]);
    await assert.rejects(makeService(env, m.f)('update_fields', {site_id: 'site-a', post_type: 'page', post_id: 2549, ...confirm, changes, ...extra}), re);
    assert(m.calls.every(c => c.o.method !== 'POST'), 'nothing written');
  };
  await refuse([{path: 'hero_title', value: 'x'}], /does not match the current title/, {confirm_title: 'Texas'});
  await refuse([{path: 'hero_title', value: 'x'}], /changed since you read it/, {expected_modified_gmt: '2026-01-01T00:00:00'});
  await refuse([{path: 'nope', value: 'x'}], /no custom field "nope".*Fields: hero_title, note/);
  await refuse([{path: 'note', value: 'x'}], /message field, which cannot be changed/);
  await refuse([{path: 'hero_title', value: ['x']}], /must be text \(text field\)/);
  await refuse([{path: 'hero_image', value: 'abc'}], /media library ID/);
  await refuse([{path: 'faqs[5].answer', value: 'x'}], /row 5 does not exist \(this field has 2 row/);
  await refuse([{path: 'faqs.answer', value: 'x'}], /take a row number such as \[0\]/);
  await refuse([{path: 'faqs[0].colour', value: 'x'}], /"colour" is not a sub field of row 0\. Sub fields: question, answer/);
  await refuse([{path: 'cta[0]', value: 'x'}], /group fields take \.sub_field/);
  await refuse([{path: 'full_page_content[0]', value: {acf_fc_layout: 'hero'}}], /changing a row's layout is not supported/);
  await refuse([{path: 'faqs', value: 'x'}], /must be a list of rows/);
  await refuse([{path: 'faqs[1].answer', replace_text: {find: 'zzz', with: 'y'}}], /does not appear/);
  await refuse([{path: 'hero_title', value: 'Steel Buildings Virginia'}], /leave every field as it is/);
  await refuse([{meta: 'state_faq', value: 'x'}], /structured data and is read-only/);
  await refuse([{meta: '_wp_page_template', value: 'x'}], /not editable on site site-a\. Editable: city_intro, state_faq/);
  await refuse([{path: 'a b', value: 'x'}], /is not valid/);
  await refuse([{path: 'hero_title'}], /needs either value or replace_text/);
  await refuse([{path: 'hero_title', value: 'x', extra: 1}], /unknown key extra/);
  await refuse([{path: 'hero_title', value: 'x'}], /in the trash/, {}, {...page(), status: 'trash'});
});

test('update_fields: the bridge\'s reason for refusing a value is shown (seen live on mktwptest.wasmer.app)', async () => {
  const refused = {ok: false, status: 400, json: async () => ({code: 'rest_invalid_param', message: 'Invalid parameter(s): mkt_fields', data: {status: 400, params: {mkt_fields: 'mkt_fields.mkt_test_style must be one of: light and dark.'}}})};
  const values = [bridge, page()];
  const f = async (u, o) => (o.method === 'POST' ? refused : {ok: true, json: async () => values.shift()});
  await assert.rejects(
    makeService(env, f)('update_fields', {site_id: 'site-a', post_type: 'page', post_id: 2549, ...confirm, changes: [{path: 'hero_title', value: 'x'}]}),
    /HTTP 400 \(rest_invalid_param\): Invalid parameter\(s\): mkt_fields\. mkt_fields: mkt_fields\.mkt_test_style must be one of: light and dark\. WordPress refused the request before saving anything\.$/,
  );
});

test('update_fields on a product category: term route, name confirmation, no modified-date guard', async () => {
  const catTax = {slug: 'product_cat', rest_base: 'product_cat', hierarchical: true};
  const termData = {source: 'acf', version: '1.3.0', fields: {bottom_content: {...text('Bottom', 'wysiwyg'), value: '<p>Old</p>'}}, meta: []};
  const term = data => ({id: 16, taxonomy: 'product_cat', name: 'Metal Carports &amp; Covers', link: 'https://a.example/c/', mkt_fields: data});
  const m = mock([catTax, bridge, term(termData), term({...termData, fields: {bottom_content: {...termData.fields.bottom_content, value: '<p>New</p>'}}})]);
  const r = await makeService(env, m.f)('update_fields', {site_id: 'site-a', taxonomy: 'product_cat', term_id: 16, changes: [{path: 'bottom_content', value: '<p>New</p>'}], confirm_title: 'Metal Carports & Covers', confirm_edit: true});
  assert.equal(m.calls[1].u, 'https://a.example/wp-json/wp/v2/product_cat');
  assert.equal(m.calls[2].u, 'https://a.example/wp-json/wp/v2/product_cat/16?context=edit&mkt_fields=1');
  assert.equal(m.calls[3].u, 'https://a.example/wp-json/wp/v2/product_cat/16');
  assert.equal(r.data.name, 'Metal Carports & Covers');
  assert.equal(r.data.live, true);
  await assert.rejects(makeService(env, mock([catTax]).f)('update_fields', {site_id: 'site-a', taxonomy: 'product_cat', term_id: 16, changes: [{path: 'x', value: 'y'}], confirm_title: 'x', confirm_edit: true, expected_modified_gmt: '2026-01-01T00:00:00'}), /no modified date for terms/);
});
