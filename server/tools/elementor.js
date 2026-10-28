'use strict';
// Elementor layouts through SEO Bridge 1.5+ ("mkt_elementor"). get_elementor_layout reads a page's layout as an outline
// (or in full); update_elementor_layout changes it, either with targeted changes by element id or as a whole new layout.
// The whole layout is checked here and again by the bridge, then saved through Elementor's own save.

const crypto = require('node:crypto');
const {raw} = require('../util.js');
const {postContext} = require('./posts.js');

const MIN_BRIDGE = '1.5.0';
const MAX_OUTLINE = 400;
const MAX_RESTORE_BYTES = 60000;
const CHANGE_KEYS = {
  settings: ['element', 'settings'],
  replace_text: ['element', 'replace_text'],
  remove: ['remove'],
  insert: ['insert', 'parent', 'position'],
};
// Settings that usually hold the visible text of a widget, in order of preference.
const TEXT_KEYS = ['title', 'editor', 'text', 'description_text', 'title_text', 'heading', 'testimonial_content', 'tab_title', 'inner_text', 'html', 'caption', 'label', 'button_text', 'prefix', 'suffix'];
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const EL_TYPE = /^[a-z][a-z0-9_-]{0,60}$/;
const WIDGET = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;

const normalize = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
// PHP sends an empty object as [].
const asObject = value => (isObject(value) ? value : {});
const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
const plain = html => String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const kindOf = el => (el.elType === 'widget' ? el.widgetType : el.elType);

function fail(message) {
  throw new Error(message);
}

/** JSON with object keys sorted and empty objects/lists alike, for comparing what was sent with what was saved. */
function stable(value) {
  if (Array.isArray(value)) return value.length ? '[' + value.map(stable).join(',') + ']' : '{}';
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return keys.length ? '{' + keys.map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}' : '{}';
  }
  return JSON.stringify(value ?? null);
}

/** SEO Bridge 1.5+ advertises mkt_elementor in the endpoint schema. Cached per site and route. */
async function requireElementorBridge(ctx, route) {
  const key = ctx.site.site_url + route;
  if (!ctx.state.elementorBridges) ctx.state.elementorBridges = new Map();
  if (ctx.state.elementorBridges.has(key)) return ctx.state.elementorBridges.get(key);
  const schema = await ctx.request(route, {method: 'OPTIONS'});
  const props = schema?.schema?.properties;
  const field = props?.mkt_elementor?.properties;
  const version = field?.version?.enum?.[0];
  if (!version) {
    const installed = props?.mkt_fields?.properties?.version?.enum?.[0] || props?.mkt_seo?.properties?.version?.enum?.[0] || (props?.mkt_seo ? '1.0.0' : '');
    fail('Elementor layouts need SEO Bridge ' + MIN_BRIDGE + ' or later on site ' + ctx.site.site_id + (installed ? ' (it has ' + installed + ')' : ' (it is not installed)') + '. In WordPress go to Plugins > Add New > Upload Plugin, upload mkt-wp-publisher-seo-bridge.zip and choose Replace current with uploaded. Nothing was changed.');
  }
  if (field.source?.enum?.[0] !== 'elementor') fail('Elementor 3.0 or later is not active on site ' + ctx.site.site_id + '. Nothing was changed.');
  const bridge = {version};
  ctx.state.elementorBridges.set(key, bridge);
  return bridge;
}

async function readLayout(ctx, pc, postId) {
  const item = await ctx.request(pc.route + '/' + postId + '?context=edit&mkt_elementor=1');
  if (!isObject(item?.mkt_elementor)) {
    fail('WordPress did not return the Elementor layout of ' + pc.kind + ' ' + postId + ' on site ' + ctx.site.site_id + '. The connected account needs permission to edit it.');
  }
  if (item.mkt_elementor.unreadable) fail('The stored Elementor layout of ' + pc.kind + ' ' + postId + ' on site ' + ctx.site.site_id + ' is not valid JSON, so it cannot be changed safely. Open it in Elementor and save it once.');
  return item;
}

/** The text a person sees in an element, for the outline. */
function visibleText(settings) {
  const s = asObject(settings);
  for (const key of TEXT_KEYS) {
    if (typeof s[key] === 'string' && plain(s[key])) return clip(plain(s[key]), 110);
  }
  // Repeaters such as icon lists and tabs: the first text of the first rows.
  for (const value of Object.values(s)) {
    if (Array.isArray(value) && value.length && isObject(value[0])) {
      const texts = value.slice(0, 3).map(row => TEXT_KEYS.map(k => (typeof row[k] === 'string' ? plain(row[k]) : '')).find(Boolean)).filter(Boolean);
      if (texts.length) return clip(texts.join(' | '), 110);
    }
  }
  return '';
}

function outline(elements) {
  const out = [];
  let total = 0;
  const walk = (list, prefix, depth) => (Array.isArray(list) ? list : []).forEach((el, i) => {
    total++;
    const path = prefix + i;
    if (out.length < MAX_OUTLINE) {
      const item = {element: el?.id, path, depth, type: isObject(el) ? kindOf(el) : 'invalid'};
      const text = isObject(el) ? visibleText(el.settings) : '';
      if (text) item.text = text;
      const kids = isObject(el) && Array.isArray(el.elements) ? el.elements.length : 0;
      if (kids) item.children = kids;
      out.push(item);
    }
    if (isObject(el)) walk(el.elements, path + '.', depth + 1);
  });
  walk(elements, '', 0);
  return {outline: out, total_elements: total, ...(total > MAX_OUTLINE ? {outline_truncated: true} : {})};
}

/** Every element by id, with its parent list, for targeted changes. */
function index(elements) {
  const byId = new Map();
  const walk = (list, parent) => list.forEach(el => {
    if (isObject(el) && typeof el.id === 'string') byId.set(el.id, {el, list, parent});
    if (isObject(el) && Array.isArray(el.elements)) walk(el.elements, el);
  });
  walk(elements, null);
  return byId;
}

function newId(taken) {
  let id;
  do id = crypto.randomBytes(4).toString('hex').slice(0, 7); while (taken.has(id));
  taken.add(id);
  return id;
}

/** Give inserted elements (and their children) ids where they have none, and the empty settings/elements Elementor expects. */
function prepareInserted(el, taken, where) {
  if (!isObject(el)) fail(where + ' must be an element object such as {"elType":"widget","widgetType":"heading","settings":{"title":"Hello"}}.');
  const copy = JSON.parse(JSON.stringify(el));
  if (copy.id === undefined) copy.id = newId(taken);
  else if (typeof copy.id === 'string' && taken.has(copy.id)) fail(where + ': id "' + copy.id + '" is already used in this layout. Leave id out to get a new one.');
  else if (typeof copy.id === 'string') taken.add(copy.id);
  if (copy.settings === undefined) copy.settings = {};
  if (copy.elements === undefined) copy.elements = [];
  if (Array.isArray(copy.elements)) copy.elements = copy.elements.map((child, i) => prepareInserted(child, taken, where + '.elements[' + i + ']'));
  return copy;
}

/** Replace text in the string settings of one element (including rows of repeaters). Returns the number of hits. */
function replaceIn(value, find, replacement) {
  let hits = 0;
  const walk = v => {
    if (typeof v === 'string') {
      const n = v.split(find).length - 1;
      hits += n;
      return n ? v.split(find).join(replacement) : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return {value: walk(value), hits};
}

/** Apply targeted changes to a copy of the layout. Throws, and changes nothing, on any problem. */
function applyChanges(elements, changes) {
  const next = JSON.parse(JSON.stringify(elements));
  const diff = [];
  changes.forEach((change, i) => {
    const where = 'changes[' + i + ']';
    const kind = Object.keys(CHANGE_KEYS).find(k => Object.hasOwn(change, k));
    if (!kind) fail(where + ' needs one of: {element, settings}, {element, replace_text}, {remove}, {insert, parent, position}.');
    const unknown = Object.keys(change).filter(k => !CHANGE_KEYS[kind].includes(k));
    if (unknown.length) fail(where + ': unknown key ' + unknown.join(', ') + ' for a ' + kind + ' change.');
    const byId = index(next);
    const find = id => {
      if (typeof id !== 'string' || !byId.has(id)) fail(where + ': there is no element "' + id + '" in this layout. Use get_elementor_layout for the element ids.');
      return byId.get(id);
    };

    if (kind === 'settings') {
      const {el} = find(change.element);
      if (!isObject(change.settings) || !Object.keys(change.settings).length) fail(where + ': settings must be an object of setting: value (null removes a setting).');
      const before = {};
      const after = {};
      const settings = {...asObject(el.settings)};
      for (const [key, value] of Object.entries(change.settings)) {
        before[key] = settings[key] ?? null;
        if (value === null) delete settings[key];
        else settings[key] = value;
        after[key] = value;
      }
      el.settings = settings;
      diff.push({change: i, element: el.id, type: kindOf(el), before, after});
    } else if (kind === 'replace_text') {
      const {el} = find(change.element);
      const spec = change.replace_text;
      if (!isObject(spec) || typeof spec.find !== 'string' || !spec.find || typeof spec.with !== 'string') fail(where + ': replace_text needs {find, with} with non-empty find text.');
      const extra = Object.keys(spec).filter(k => !['find', 'with', 'all'].includes(k));
      if (extra.length) fail(where + ': replace_text takes find, with and all only.');
      const {value, hits} = replaceIn(asObject(el.settings), spec.find, spec.with);
      if (!hits) fail(where + ': "' + clip(spec.find, 60) + '" does not appear in the settings of element ' + el.id + '. Nothing was changed.');
      if (hits > 1 && spec.all !== true) fail(where + ': "' + clip(spec.find, 60) + '" appears ' + hits + ' times in element ' + el.id + '. Give more surrounding text, or all: true. Nothing was changed.');
      el.settings = value;
      diff.push({change: i, element: el.id, type: kindOf(el), before: clip(spec.find, 200), after: clip(spec.with, 200), replaced: hits});
    } else if (kind === 'remove') {
      const {el, list} = find(change.remove);
      list.splice(list.indexOf(el), 1);
      diff.push({change: i, removed: el.id, type: kindOf(el), ...(visibleText(el.settings) ? {text: visibleText(el.settings)} : {})});
    } else {
      const taken = new Set(index(next).keys());
      const items = (Array.isArray(change.insert) ? change.insert : [change.insert]).map((el, n) => prepareInserted(el, taken, where + '.insert' + (Array.isArray(change.insert) ? '[' + n + ']' : '')));
      if (!items.length) fail(where + ': insert needs at least one element.');
      let target = next;
      if (change.parent !== undefined && change.parent !== null) {
        const {el} = find(change.parent);
        if (!Array.isArray(el.elements)) el.elements = [];
        target = el.elements;
      }
      const position = change.position === undefined ? target.length : change.position;
      if (!Number.isSafeInteger(position) || position < 0 || position > target.length) fail(where + ': position must be a whole number from 0 to ' + target.length + ' (leave it out to add at the end).');
      target.splice(position, 0, ...items);
      diff.push({change: i, inserted: items.map(el => el.id), parent: change.parent ?? null, position});
    }
  });
  return {elements: next, diff};
}

const childAllowed = (parent, child) => {
  if (parent === 'widget') return false;
  if (parent === null) return !['widget', 'column'].includes(child);
  if (parent === 'section') return child === 'column';
  if (parent === 'column') return ['widget', 'section'].includes(child);
  return !['column', 'section'].includes(child);
};

/**
 * isInner as the bridge sets it before saving (false at the top level, true for nested sections and containers), so
 * what is sent is what Elementor stores and the saved layout can be compared with it.
 */
function withInner(list, nested = false) {
  return (Array.isArray(list) ? list : []).map(el => {
    if (!isObject(el)) return el;
    const copy = {...el};
    if (['section', 'container'].includes(copy.elType)) copy.isInner = nested;
    if (Array.isArray(copy.elements)) copy.elements = withInner(copy.elements, true);
    return copy;
  });
}

/** The same structure rules the bridge applies, checked first so problems are reported before any request. */
function checkLayout(elements, widgetTypes) {
  const ids = new Set();
  let count = 0;
  const walk = (list, parent, path, inInner, depth) => {
    if (!Array.isArray(list)) fail(path + ' must be a list of elements.');
    if (depth > 30) fail(path + ' is nested more than 30 levels deep.');
    list.forEach((el, i) => {
      const where = path + '[' + i + ']';
      if (!isObject(el)) fail(where + ' must be an element object.');
      if (++count > 5000) fail('The layout has more than 5000 elements.');
      if (typeof el.id !== 'string' || !ID.test(el.id)) fail(where + '.id must be a short id of letters and digits, such as 3f2a9c1.');
      if (ids.has(el.id)) fail(where + '.id "' + el.id + '" is used twice; every element needs its own id.');
      ids.add(el.id);
      if (typeof el.elType !== 'string' || !EL_TYPE.test(el.elType)) fail(where + '.elType must be section, column, container, widget or another Elementor element type.');
      if (!childAllowed(parent, el.elType)) fail(where + ' (' + el.id + '): a ' + el.elType + ' cannot be placed ' + (parent === null ? 'at the top level' : 'inside a ' + parent) + '.');
      if (el.elType === 'section' && inInner) fail(where + ' (' + el.id + '): Elementor allows inner sections only one level deep.');
      if (el.settings !== undefined && !isObject(el.settings) && !(Array.isArray(el.settings) && !el.settings.length)) fail(where + '.settings must be an object.');
      if (el.elType === 'widget') {
        if (typeof el.widgetType !== 'string' || !WIDGET.test(el.widgetType)) fail(where + '.widgetType must name an Elementor widget, such as heading or text-editor.');
        if (Array.isArray(widgetTypes) && !widgetTypes.includes(el.widgetType)) fail(where + ' (' + el.id + '): the widget "' + el.widgetType + '" is not registered on this site, so Elementor would drop it. Use get_elementor_layout with widgets: true for the list.');
        if (Array.isArray(el.elements) && el.elements.length) fail(where + ' (' + el.id + '): a widget cannot contain other elements.');
      }
      const inner = inInner || (el.elType === 'section' && parent !== null);
      walk(el.elements === undefined ? [] : el.elements, el.elType, where + '.elements', inner, depth + 1);
    });
  };
  walk(elements, null, 'elements', false, 1);
  return count;
}

function about(pc, item) {
  return {post_id: item.id, ...(item.type ? {post_type: item.type} : {}), status: item.status, title: raw(item.title), url: item.link, modified_gmt: item.modified_gmt, ...pc.preview(item)};
}

module.exports = {
  async get_elementor_layout(ctx, args) {
    const pc = await postContext(ctx, args);
    const bridge = await requireElementorBridge(ctx, pc.route);
    const item = await readLayout(ctx, pc, args.post_id);
    const layout = item.mkt_elementor;
    const elements = Array.isArray(layout.elements) ? layout.elements : [];
    const builder = isObject(item.mkt_builder) ? item.mkt_builder : null;
    const notes = [];
    if (builder && builder.id !== 'elementor') notes.push('This ' + pc.kind + ' is built with ' + builder.name + ', not Elementor; its layout cannot be changed with update_elementor_layout.');
    else if (!layout.built_with_elementor) notes.push('This ' + pc.kind + ' is not built with Elementor yet. update_elementor_layout with convert: true switches it to Elementor and replaces its current content.');
    if (layout.editable === false) notes.push('Elementor does not allow the connected account to edit this ' + pc.kind + ' (Elementor > Settings > General > Post Types, or the Role Manager).');
    if (layout.locked_by) notes.push(layout.locked_by + ' has it open in an editor right now; changes are refused until they close it.');
    return ctx.result({
      ...about(pc, item),
      built_with_elementor: !!layout.built_with_elementor,
      editable: layout.editable !== false,
      elementor_version: layout.elementor_version,
      bridge_version: bridge.version,
      template: layout.template || 'default',
      page_settings: asObject(layout.page_settings),
      ...outline(elements),
      ...(args.widgets ? {widget_types: Array.isArray(layout.widget_types) ? layout.widget_types : null} : {}),
      ...(args.full ? {elements} : {}),
      ...(notes.length ? {note: notes.join(' ')} : {}),
    });
  },

  async update_elementor_layout(ctx, args) {
    if (!normalize(args.confirm_title)) fail('confirm_title cannot be blank.');
    const hasElements = args.elements !== undefined;
    const hasChanges = args.changes !== undefined;
    if (hasElements && hasChanges) fail('Pass either elements (the whole new layout) or changes (targeted changes), not both.');
    if (!hasElements && !hasChanges && args.page_settings === undefined) fail('Pass changes, elements or page_settings.');
    if (args.convert !== undefined && !hasElements && !hasChanges) fail('convert applies together with elements or changes.');
    if (args.page_settings !== undefined) {
      const refused = Object.keys(args.page_settings).filter(k => k.startsWith('post_') || ['menu_order', 'comment_status', 'ping_status'].includes(k));
      if (refused.length) fail('page_settings cannot change ' + refused.join(', ') + '. The title, status, excerpt and featured image change through get_post / update_draft / edit_published_post / publish_post. Nothing was changed.');
    }
    const pc = await postContext(ctx, args);
    await requireElementorBridge(ctx, pc.route);
    const item = await readLayout(ctx, pc, args.post_id);
    if (normalize(args.confirm_title) !== normalize(raw(item.title))) {
      fail('confirm_title does not match the current title of ' + pc.kind + ' ' + args.post_id + ' on site ' + ctx.site.site_id + '. Read it with get_elementor_layout and confirm the right site and ' + pc.kind + ' with the user.');
    }
    if (args.expected_modified_gmt !== undefined) {
      const stamp = text => String(text ?? '').replace(/(?:\.\d+)?(?:Z|\+00:00)$/i, '');
      if (stamp(args.expected_modified_gmt) !== stamp(item.modified_gmt)) {
        fail(pc.kind[0].toUpperCase() + pc.kind.slice(1) + ' ' + args.post_id + ' on site ' + ctx.site.site_id + ' changed since you read it (modified_gmt is now ' + item.modified_gmt + '). Read it again and check with the user; nothing was written.');
      }
    }
    if (item.status === 'trash') fail('This ' + pc.kind + ' is in the trash. Restore it in WordPress first.');
    const layout = item.mkt_elementor;
    const builder = isObject(item.mkt_builder) ? item.mkt_builder : null;
    if (builder && builder.id !== 'elementor') fail('This ' + pc.kind + ' is built with ' + builder.name + ', not Elementor. Nothing was changed.');
    if (layout.locked_by) fail(layout.locked_by + ' is editing this ' + pc.kind + ' in WordPress right now. Ask them to close the editor, then retry. Nothing was changed.');
    if (layout.editable === false) fail('Elementor does not allow the connected account to edit this ' + pc.kind + '. Check Elementor > Settings > General > Post Types (and the Role Manager). Nothing was changed.');
    const touchesLayout = hasElements || hasChanges;
    if (touchesLayout && !layout.built_with_elementor && args.convert !== true) {
      const content = typeof item.content?.raw === 'string' && item.content.raw.trim();
      fail('This ' + pc.kind + ' is not built with Elementor yet. To switch it to Elementor, call again with convert: true after the user agrees' + (content ? '; its current content (' + content.length + ' characters) is then replaced by the layout' : '') + '. Nothing was changed.');
    }

    const before = Array.isArray(layout.elements) ? layout.elements : [];
    const widgetTypes = Array.isArray(layout.widget_types) ? layout.widget_types : null;
    let next = before;
    let diff = [];
    if (hasChanges) ({elements: next, diff} = applyChanges(before, args.changes));
    if (hasElements) {
      // Elements without an id get a new one; ids that are given must be unique.
      const taken = new Set();
      next = args.elements.map((el, i) => prepareInserted(el, taken, 'elements[' + i + ']'));
      diff = [{replaced_layout: true, elements_before: outline(before).total_elements}];
    }
    const total = touchesLayout ? checkLayout(next, widgetTypes) : outline(before).total_elements;
    if (touchesLayout) next = withInner(next);
    const layoutChanged = touchesLayout && stable(next) !== stable(withInner(before));
    const settingsChanged = args.page_settings !== undefined && Object.entries(args.page_settings).some(([k, v]) => stable(asObject(layout.page_settings)[k]) !== stable(v));
    if (!layoutChanged && !settingsChanged && !(touchesLayout && !layout.built_with_elementor)) fail('The changes leave the layout exactly as it is. Nothing was saved.');

    // Elementor saves page settings as a whole, so the current ones are sent with the changes; null removes a setting.
    let pageSettings;
    if (args.page_settings !== undefined) {
      pageSettings = Object.fromEntries(Object.entries(asObject(layout.page_settings)).filter(([k]) => !k.startsWith('post_')));
      for (const [key, value] of Object.entries(args.page_settings)) {
        if (value === null) delete pageSettings[key];
        else pageSettings[key] = value;
      }
    }
    const body = {
      mkt_elementor: {
        ...(touchesLayout ? {elements: next} : {}),
        ...(pageSettings ? {page_settings: pageSettings} : {}),
        ...(args.convert === true ? {convert: true} : {}),
      },
    };
    const saved = await ctx.request(pc.route + '/' + args.post_id, {method: 'POST', body});
    const warnings = [];
    const savedLayout = isObject(saved?.mkt_elementor) ? saved.mkt_elementor : null;
    if (!savedLayout) {
      warnings.push('WordPress did not return the layout after saving. Check it with get_elementor_layout.');
    } else if (touchesLayout && stable(savedLayout.elements) !== stable(next)) {
      warnings.push('Elementor stored the layout differently from what was sent (for example it filtered HTML this account may not post). Check it with get_elementor_layout.');
    }
    if (saved?.status && saved.status !== item.status) warnings.push('Its status changed from ' + item.status + ' to ' + saved.status + '. Check it in WordPress.');
    const previous = JSON.stringify(before);
    return ctx.result({
      ...about(pc, saved && saved.id ? saved : item),
      changes: diff,
      total_elements: total,
      live: item.status === 'publish',
      ...(touchesLayout && !layout.built_with_elementor ? {converted_to_elementor: true} : {}),
      ...(touchesLayout ? (previous.length <= MAX_RESTORE_BYTES ? {restore: {elements: before}} : {restore_note: 'The previous layout is too large to return here.'}) : {}),
      undo: 'Elementor keeps revisions: open the ' + pc.kind + ' with Edit with Elementor > History > Revisions to go back.' + (touchesLayout && previous.length <= MAX_RESTORE_BYTES ? ' Or call update_elementor_layout again with elements set to restore.elements.' : ''),
      ...(warnings.length ? {warning: warnings.join(' ')} : {}),
    });
  },
};
