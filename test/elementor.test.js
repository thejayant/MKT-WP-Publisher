'use strict';
// get_elementor_layout / update_elementor_layout: Elementor layouts through SEO Bridge 1.5 ("mkt_elementor").
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {makeService} = require('../server/service.js');
const {env, mock} = require('./helpers.js');

const bridge = {schema: {properties: {mkt_elementor: {properties: {source: {enum: ['elementor']}, version: {enum: ['1.5.0']}}}}}};
const WIDGETS = ['heading', 'text-editor', 'button', 'image', 'icon-list'];
// A classic section/column page plus a container, as Elementor stores them.
const layoutElements = () => [
  {id: 'sec1', elType: 'section', isInner: false, settings: {}, elements: [
    {id: 'col1', elType: 'column', settings: {_column_size: 100}, elements: [
      {id: 'h1', elType: 'widget', widgetType: 'heading', settings: {title: 'Metal Buildings Florida'}, elements: []},
      {id: 'txt1', elType: 'widget', widgetType: 'text-editor', settings: {editor: '<p>We serve all 67 Florida counties.</p>'}, elements: []},
    ]},
  ]},
  {id: 'con1', elType: 'container', isInner: false, settings: {flex_direction: 'row'}, elements: [
    {id: 'btn1', elType: 'widget', widgetType: 'button', settings: {text: 'Get a quote', link: {url: 'https://s.example/quote/'}}, elements: []},
    {id: 'list1', elType: 'widget', widgetType: 'icon-list', settings: {icon_list: [{text: 'Free delivery'}, {text: 'Free install'}]}, elements: []},
  ]},
];
const layout = (over = {}) => ({
  source: 'elementor', version: '1.5.0', elementor_version: '3.25.0', built_with_elementor: true, editable: true,
  template: 'elementor_header_footer', page_settings: {background_color: '#fff'}, elements: layoutElements(),
  widget_types: WIDGETS, locked_by: '', ...over,
});
const page = (over = {}, layoutOver = {}) => ({
  id: 1941, type: 'page', status: 'publish', title: {raw: 'Florida'}, link: 'https://s.example/florida/', modified_gmt: '2026-10-20T10:00:00',
  content: {raw: '<p>copy</p>'}, mkt_builder: {id: 'elementor', name: 'Elementor', storage: 'meta'}, mkt_elementor: layout(layoutOver), ...over,
});
const confirm = {confirm_title: 'Florida', confirm_edit: true};
const call = (m, args) => makeService(env, m.f)('update_elementor_layout', {site_id: 'site-a', post_type: 'page', post_id: 1941, ...confirm, ...args});
// The POST answer: WordPress returns the post with the layout as saved.
const savedFrom = m => ({...page(), mkt_elementor: layout({elements: m.calls.at(-1)?.o?.body ? JSON.parse(m.calls.at(-1).o.body).mkt_elementor.elements : layoutElements()})});

test('get_elementor_layout: bridge check, read with ?mkt_elementor=1, outline with ids, types and text', async () => {
  const m = mock([bridge, page()]);
  const r = await makeService(env, m.f)('get_elementor_layout', {site_id: 'site-a', post_type: 'page', post_id: 1941});
  assert.equal(m.calls[0].o.method, 'OPTIONS');
  assert.equal(m.calls[1].u, 'https://a.example/wp-json/wp/v2/pages/1941?context=edit&mkt_elementor=1');
  assert.equal(r.data.built_with_elementor, true);
  assert.equal(r.data.template, 'elementor_header_footer');
  assert.equal(r.data.total_elements, 7);
  const byId = Object.fromEntries(r.data.outline.map(o => [o.element, o]));
  assert.deepEqual(byId.h1, {element: 'h1', path: '0.0.0', depth: 2, type: 'heading', text: 'Metal Buildings Florida'});
  assert.equal(byId.txt1.text, 'We serve all 67 Florida counties.', 'HTML stripped');
  assert.equal(byId.list1.text, 'Free delivery | Free install', 'repeater rows');
  assert.equal(byId.sec1.children, 1);
  assert(!('elements' in r.data) && !('widget_types' in r.data), 'full layout and widget list only on request');
  const full = await makeService(env, mock([bridge, page()]).f)('get_elementor_layout', {site_id: 'site-a', post_type: 'page', post_id: 1941, full: true, widgets: true});
  assert.equal(full.data.elements.length, 2);
  assert.deepEqual(full.data.widget_types, WIDGETS);
  const plain = await makeService(env, mock([bridge, page({mkt_builder: null}, {built_with_elementor: false, elements: []})]).f)('get_elementor_layout', {site_id: 'site-a', post_type: 'page', post_id: 1941});
  assert.match(plain.data.note, /not built with Elementor yet.*convert: true/);
});

test('Elementor tools: clear errors for a missing or old bridge and for sites without Elementor', async () => {
  const old = mock([{schema: {properties: {mkt_fields: {properties: {version: {enum: ['1.4.0']}}}}}}]);
  await assert.rejects(makeService(env, old.f)('get_elementor_layout', {site_id: 'site-a', post_id: 1}), /SEO Bridge 1\.5\.0 or later on site site-a \(it has 1\.4\.0\).*Nothing was changed/);
  assert.equal(old.calls.length, 1);
  const none = mock([{schema: {properties: {}}}]);
  await assert.rejects(call(none, {changes: [{remove: 'h1'}]}), /\(it is not installed\)/);
  const noElementor = mock([{schema: {properties: {mkt_elementor: {properties: {source: {enum: ['none']}, version: {enum: ['1.5.0']}}}}}}]);
  await assert.rejects(call(noElementor, {changes: [{remove: 'h1'}]}), /Elementor 3\.0 or later is not active on site site-a/);
  assert.equal(noElementor.calls.length, 1);
});

test('update_elementor_layout: targeted changes by element id, one POST, restore and undo', async () => {
  const m = mock([bridge, page()]);
  const values = [bridge, page()];
  const f = async (u, o) => {
    m.calls.push({u, o});
    if (o.method === 'POST') return {ok: true, json: async () => savedFrom(m)};
    return {ok: true, json: async () => values.shift()};
  };
  const r = await makeService(env, f)('update_elementor_layout', {
    site_id: 'site-a', post_type: 'page', post_id: 1941, ...confirm, expected_modified_gmt: '2026-10-20T10:00:00Z',
    changes: [
      {element: 'h1', settings: {title: 'Steel Buildings Florida', header_size: 'h1'}},
      {element: 'txt1', replace_text: {find: 'all 67 Florida counties', with: 'every county in Florida'}},
      {element: 'list1', replace_text: {find: 'Free', with: 'No-cost', all: true}},
      {remove: 'btn1'},
      {insert: {elType: 'widget', widgetType: 'image', settings: {image: {id: 77}}}, parent: 'col1', position: 0},
      {element: 'h1', settings: {header_size: null}},
    ],
  });
  const posts = m.calls.filter(c => c.o.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].u, 'https://a.example/wp-json/wp/v2/pages/1941');
  const sent = JSON.parse(posts[0].o.body).mkt_elementor;
  assert.deepEqual(Object.keys(sent), ['elements'], 'only the layout is sent; no convert, no page settings');
  const col = sent.elements[0].elements[0];
  assert.equal(col.elements[0].widgetType, 'image', 'inserted at position 0');
  assert.match(col.elements[0].id, /^[0-9a-f]{7}$/, 'a new id was given');
  assert.deepEqual(col.elements[0].elements, [], 'with the empty children Elementor expects');
  assert.deepEqual(col.elements[1].settings, {title: 'Steel Buildings Florida'}, 'settings merged; null removed one');
  assert.equal(col.elements[2].settings.editor, '<p>We serve every county in Florida.</p>');
  assert.deepEqual(sent.elements[1].elements.map(e => e.id), ['list1'], 'button removed');
  assert.deepEqual(sent.elements[1].elements[0].settings.icon_list, [{text: 'No-cost delivery'}, {text: 'No-cost install'}]);
  assert.equal(sent.elements[1].settings.flex_direction, 'row', 'everything else kept as stored');
  assert.equal(r.data.live, true);
  assert.equal(r.data.changes.length, 6);
  assert.equal(r.data.changes[2].replaced, 2);
  assert.deepEqual(r.data.restore.elements, layoutElements());
  assert.match(r.data.undo, /History > Revisions.*restore\.elements/);
  assert(!r.data.warning, r.data.warning);
});

test('update_elementor_layout: everything is refused before any write', async () => {
  const cases = [
    [{confirm_title: 'Texas'}, {}, {}, /confirm_title does not match/],
    [{expected_modified_gmt: '2026-10-19T00:00:00'}, {}, {}, /changed since you read it/],
    [{}, {mkt_builder: {id: 'divi', name: 'Divi', storage: 'content'}}, {}, /built with Divi, not Elementor/],
    [{}, {}, {locked_by: 'Priya'}, /Priya is editing this page/],
    [{}, {}, {editable: false}, /does not allow the connected account.*Post Types/],
    [{}, {mkt_builder: null}, {built_with_elementor: false}, /not built with Elementor yet.*convert: true.*11 characters/],
    [{}, {status: 'trash'}, {}, /in the trash/],
    [{changes: [{insert: {elType: 'widget', widgetType: 'slider-pro'}, parent: 'col1'}]}, {}, {}, /widget "slider-pro" is not registered on this site/],
    [{changes: [{insert: {elType: 'widget', widgetType: 'heading'}}]}, {}, {}, /a widget cannot be placed at the top level/],
    [{changes: [{insert: {elType: 'column'}, parent: 'con1'}]}, {}, {}, /a column cannot be placed inside a container/],
    [{changes: [{insert: {elType: 'section', elements: [{elType: 'column', elements: [{elType: 'section'}]}]}, parent: 'col1'}]}, {}, {}, /inner sections only one level deep/],
    [{changes: [{insert: {id: 'h1', elType: 'widget', widgetType: 'heading'}, parent: 'col1'}]}, {}, {}, /id "h1" is already used/],
    [{changes: [{insert: {elType: 'widget', widgetType: 'heading', elements: [{elType: 'widget', widgetType: 'heading'}]}, parent: 'col1'}]}, {}, {}, /a widget cannot contain other elements/],
    [{changes: [{insert: {elType: 'widget', widgetType: 'heading'}, parent: 'col1', position: 9}]}, {}, {}, /position must be a whole number from 0 to 2/],
    [{changes: [{remove: 'nope'}]}, {}, {}, /no element "nope".*get_elementor_layout/],
    [{changes: [{element: 'list1', replace_text: {find: 'Free', with: 'X'}}]}, {}, {}, /appears 2 times in element list1/],
    [{changes: [{element: 'h1', replace_text: {find: 'Texas', with: 'X'}}]}, {}, {}, /does not appear in the settings of element h1/],
    [{changes: [{element: 'h1', settings: {title: 'Metal Buildings Florida'}}]}, {}, {}, /leave the layout exactly as it is/],
    [{changes: [{element: 'h1', wipe: true}]}, {}, {}, /needs one of/],
    [{changes: [{element: 'h1', settings: {a: 1}, remove: 'x'}]}, {}, {}, /unknown key remove/],
    [{elements: [{id: 'a', elType: 'section', elements: []}, {id: 'a', elType: 'container'}]}, {}, {}, /id "a" is already used in this layout/],
    [{elements: [{id: 'a', elType: 'section', settings: ['x']}]}, {}, {}, /settings must be an object/],
  ];
  for (const [args, postOver, layoutOver, pattern] of cases) {
    const m = mock([bridge, page(postOver, layoutOver)]);
    const finalArgs = {changes: [{remove: 'btn1'}], ...args};
    if (finalArgs.elements) delete finalArgs.changes;
    await assert.rejects(call(m, finalArgs), pattern, JSON.stringify(args));
    assert(!m.calls.some(c => c.o.method === 'POST'), 'no write for ' + JSON.stringify(args));
  }
});

test('update_elementor_layout: argument rules are checked before any request', async () => {
  const m = mock([]);
  await assert.rejects(call(m, {changes: [{remove: 'a'}], elements: []}), /either elements .* or changes/);
  await assert.rejects(call(m, {}), /Pass changes, elements or page_settings/);
  await assert.rejects(call(m, {page_settings: {post_status: 'publish'}}), /page_settings cannot change post_status/);
  await assert.rejects(call(m, {convert: true, page_settings: {a: 1}}), /convert applies together with elements or changes/);
  await assert.rejects(call(m, {page_settings: []}), /page_settings must be an object/);
  await assert.rejects(call(m, {changes: [{remove: 'a'}], confirm_edit: false}), /confirm_edit must be true/);
  assert.equal(m.calls.length, 0);
});

test('update_elementor_layout: convert a page to Elementor with a whole new layout', async () => {
  const withIds = [{id: 'c1', elType: 'container', isInner: false, settings: {}, elements: [{id: 'w1', elType: 'widget', widgetType: 'heading', settings: {title: 'New'}, elements: []}]}];
  const m2 = mock([bridge, page({status: 'draft', mkt_builder: null}, {built_with_elementor: false, elements: []})]);
  const f2 = async (u, o) => (o.method === 'POST' ? (m2.calls.push({u, o}), {ok: true, json: async () => ({...page({status: 'draft'}), mkt_elementor: layout({elements: JSON.parse(o.body).mkt_elementor.elements})})}) : m2.f(u, o));
  const r = await makeService(env, f2)('update_elementor_layout', {site_id: 'site-a', post_type: 'page', post_id: 1941, ...confirm, elements: withIds, convert: true});
  const sent = JSON.parse(m2.calls.at(-1).o.body).mkt_elementor;
  assert.equal(sent.convert, true);
  assert.deepEqual(sent.elements, withIds);
  assert.equal(r.data.converted_to_elementor, true);
  assert.equal(r.data.live, false);
  assert.deepEqual(r.data.restore.elements, []);
  assert.deepEqual(r.data.changes, [{replaced_layout: true, elements_before: 0}]);
});

test('update_elementor_layout: whole layouts get ids where they have none; given ids must be valid and unique', async () => {
  const m = mock([bridge, page()]);
  const f = async (u, o) => (o.method === 'POST' ? (m.calls.push({u, o}), {ok: true, json: async () => savedFrom(m)}) : m.f(u, o));
  await makeService(env, f)('update_elementor_layout', {site_id: 'site-a', post_type: 'page', post_id: 1941, ...confirm, elements: [{elType: 'container', elements: [{elType: 'widget', widgetType: 'heading', settings: {title: 'Hi'}}]}]});
  const sent = JSON.parse(m.calls.at(-1).o.body).mkt_elementor.elements;
  assert.match(sent[0].id, /^[0-9a-f]{7}$/);
  assert.match(sent[0].elements[0].id, /^[0-9a-f]{7}$/);
  assert.notEqual(sent[0].id, sent[0].elements[0].id);
  const bad = mock([bridge, page()]);
  await assert.rejects(call(bad, {elements: [{id: 'a b', elType: 'container'}]}), /elements\[0\]\.id must be a short id/);
  await assert.rejects(call(mock([bridge, page()]), {elements: [{id: 'a', elType: 'container'}, {id: 'a', elType: 'container'}]}), /id "a" is already used in this layout/);
  assert(!bad.calls.some(c => c.o.method === 'POST'));
});

test('update_elementor_layout: page settings are merged with the current ones; null removes one', async () => {
  const m = mock([bridge, page({}, {page_settings: {background_color: '#fff', hide_title: 'yes'}})]);
  const f = async (u, o) => (o.method === 'POST' ? (m.calls.push({u, o}), {ok: true, json: async () => page()}) : m.f(u, o));
  await makeService(env, f)('update_elementor_layout', {site_id: 'site-a', post_type: 'page', post_id: 1941, ...confirm, page_settings: {template: 'elementor_canvas', hide_title: null}});
  const sent = JSON.parse(m.calls.at(-1).o.body).mkt_elementor;
  assert.deepEqual(sent, {page_settings: {background_color: '#fff', template: 'elementor_canvas'}}, 'layout not sent when only settings change');
  const same = mock([bridge, page()]);
  await assert.rejects(makeService(env, same.f)('update_elementor_layout', {site_id: 'site-a', post_type: 'page', post_id: 1941, ...confirm, page_settings: {background_color: '#fff'}}), /leave the layout exactly as it is/);
});

test('update_elementor_layout: a layout stored differently from what was sent is reported', async () => {
  const m = mock([bridge, page(), page()]);
  const f = async (u, o) => {
    if (o.method === 'POST') return {ok: true, json: async () => page()};
    return m.f(u, o);
  };
  const r = await makeService(env, f)('update_elementor_layout', {site_id: 'site-a', post_type: 'page', post_id: 1941, ...confirm, changes: [{remove: 'btn1'}]});
  assert.match(r.data.warning, /stored the layout differently/);
});

test('regression (live test on mktwptest.wasmer.app): isInner is set as the bridge sets it, so no false "stored differently" warning', async () => {
  // The bridge adds isInner (false at the top level, true when nested) before Elementor saves. The tool now sends the
  // same, so a layout stored exactly as sent is not reported as different.
  const m = mock([bridge, page({status: 'draft', mkt_builder: null}, {built_with_elementor: false, elements: []})]);
  const bridgeSave = elements => elements.map(function inner(el, i, all, nested = false) {
    const copy = {...el};
    if (['section', 'container'].includes(copy.elType)) copy.isInner = nested;
    copy.elements = (copy.elements || []).map((child, j, kids) => inner(child, j, kids, true));
    return copy;
  });
  const f = async (u, o) => (o.method === 'POST'
    ? (m.calls.push({u, o}), {ok: true, json: async () => ({...page({status: 'draft'}), mkt_elementor: layout({elements: bridgeSave(JSON.parse(o.body).mkt_elementor.elements)})})})
    : m.f(u, o));
  const r = await makeService(env, f)('update_elementor_layout', {site_id: 'site-a', post_type: 'page', post_id: 1941, ...confirm, convert: true,
    elements: [{elType: 'container', elements: [{elType: 'container', elements: [{elType: 'widget', widgetType: 'heading', settings: {title: 'Hi'}}]}]}]});
  const sent = JSON.parse(m.calls.at(-1).o.body).mkt_elementor.elements;
  assert.equal(sent[0].isInner, false);
  assert.equal(sent[0].elements[0].isInner, true);
  assert.equal(r.data.warning, undefined, r.data.warning);
});
