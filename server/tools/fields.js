'use strict';
// Custom fields through SEO Bridge 1.3+ ("mkt_fields"): Advanced Custom Fields on posts, pages, products and terms, plus
// meta keys the site lists as editable. update_fields changes one value by path and writes the whole top-level field
// back, so other rows, layouts and sub fields stay exactly as stored.

const {raw, decode, checkText} = require('../util.js');
const {postContext} = require('./posts.js');
const {resolveTaxonomy} = require('./taxonomy.js');

const MIN_BRIDGE = '1.3.0';
const TEXT_TYPES = new Set(['text', 'textarea', 'wysiwyg', 'oembed', 'email', 'url', 'color_picker', 'date_picker', 'date_time_picker', 'time_picker']);
const MAX_PATHS = 300;
const PATH = /^([^.[\]\s]+)((?:\[\d+\]|\.[^.[\]\s]+)*)$/;
const CHANGE_KEYS = new Set(['path', 'value', 'replace_text', 'meta']);

const normalize = text => decode(String(text ?? '')).replace(/\s+/g, ' ').trim();
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
// PHP sends an empty object as [].
const asObject = value => (isObject(value) ? value : {});
const isId = value => (Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && /^[1-9]\d*$/.test(value));
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** The post (post_id + post_type) or term (taxonomy + term_id) the call is about. */
async function target(ctx, args) {
  if (args.taxonomy !== undefined || args.term_id !== undefined) {
    if (args.post_id !== undefined || args.post_type !== undefined) throw new Error('Pass either post_id (with post_type) or taxonomy with term_id, not both.');
    if (args.taxonomy === undefined || args.term_id === undefined) throw new Error('A category or tag needs both taxonomy and term_id.');
    const tax = await resolveTaxonomy(ctx, args.taxonomy);
    return {kind: 'term', base: tax.route, route: tax.route + '/' + args.term_id, noun: tax.slug + ' term', id: args.term_id};
  }
  if (args.post_id === undefined) throw new Error('Pass post_id (with post_type for pages, products and other types), or taxonomy with term_id.');
  const pc = await postContext(ctx, args);
  return {kind: 'post', base: pc.route, route: pc.route + '/' + args.post_id, noun: pc.kind, id: args.post_id};
}

/** SEO Bridge 1.3+ advertises mkt_fields in the endpoint schema. Cached per site and route. */
async function requireFieldsBridge(ctx, base) {
  const key = ctx.site.site_url + base;
  if (ctx.state.fieldBridges.has(key)) return ctx.state.fieldBridges.get(key);
  const schema = await ctx.request(base, {method: 'OPTIONS'});
  const props = schema?.schema?.properties;
  const version = props?.mkt_fields?.properties?.version?.enum?.[0];
  if (!version) {
    const installed = props?.mkt_seo?.properties?.version?.enum?.[0] || (props?.mkt_seo ? '1.0.0' : '');
    throw new Error('Custom fields need SEO Bridge ' + MIN_BRIDGE + ' or later on site ' + ctx.site.site_id + (installed ? ' (it has ' + installed + ')' : ' (it is not installed)') + '. In WordPress go to Plugins > Add New > Upload Plugin, upload mkt-wp-publisher-seo-bridge.zip and choose Replace current with uploaded. Nothing was changed.');
  }
  const bridge = {version, source: props.mkt_fields.properties.source?.enum?.[0] || 'none'};
  ctx.state.fieldBridges.set(key, bridge);
  return bridge;
}

async function readItem(ctx, t) {
  const item = await ctx.request(t.route + '?context=edit&mkt_fields=1');
  if (!isObject(item?.mkt_fields)) {
    throw new Error('WordPress did not return the custom fields of ' + t.noun + ' ' + t.id + ' on site ' + ctx.site.site_id + '. The connected account needs permission to edit it.');
  }
  return item;
}

function about(t, item) {
  return t.kind === 'term'
    ? {term_id: item.id, taxonomy: item.taxonomy, name: decode(item.name), link: item.link}
    : {post_id: item.id, ...(item.type ? {post_type: item.type} : {}), status: item.status, title: raw(item.title), url: item.link, modified_gmt: item.modified_gmt};
}

/** Flat list of every value with its update_fields path, type and a short preview. */
function outlinePaths(fields) {
  const out = [];
  const preview = value => {
    const text = typeof value === 'string' ? value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : JSON.stringify(value ?? null);
    return text.length > 80 ? text.slice(0, 79) + '…' : text;
  };
  const rows = (value, path, subsOf) => (Array.isArray(value) ? value : []).forEach((row, i) => {
    for (const [name, sub] of Object.entries(subsOf(asObject(row)))) walk(sub, asObject(row)[name], path + '[' + i + '].' + name);
  });
  const walk = (def, value, path) => {
    if (out.length >= MAX_PATHS) return;
    if (def.type === 'group') {
      for (const [name, sub] of Object.entries(asObject(def.sub_fields))) walk(sub, asObject(value)[name], path + '.' + name);
    } else if (def.type === 'repeater') {
      rows(value, path, () => asObject(def.sub_fields));
    } else if (def.type === 'flexible_content') {
      rows(value, path, row => asObject(asObject(def.layouts)[row.acf_fc_layout]?.sub_fields));
    } else {
      out.push({path, type: def.type, writable: !!def.writable, value: preview(value)});
    }
  };
  for (const [name, def] of Object.entries(fields)) walk(asObject(def), asObject(def).value, name);
  return out;
}

function parsePath(path, where) {
  const match = PATH.exec(path.trim());
  if (!match) {
    throw new Error(where + ': path "' + path + '" is not valid. Use a path from inspect_fields, such as hero_title, cta.label, faqs[1].answer or full_page_content[0].2_column_content_row[0].2_column_content_text.');
  }
  const tokens = [{name: match[1]}];
  for (const part of match[2].matchAll(/\[(\d+)\]|\.([^.[\]\s]+)/g)) tokens.push(part[1] !== undefined ? {index: Number(part[1])} : {name: part[2]});
  return tokens;
}

function replaceText(current, spec, where) {
  if (!isObject(spec) || typeof spec.find !== 'string' || !spec.find || typeof spec.with !== 'string') {
    throw new Error(where + ': replace_text needs {find, with} with non-empty find text.');
  }
  const count = current.split(spec.find).length - 1;
  if (!count) throw new Error(where + ': the find text does not appear in the current value. Read it again with inspect_fields.');
  if (count > 1 && spec.all !== true) throw new Error(where + ': the find text appears ' + count + ' times. Make it longer so it matches once, or set all: true.');
  return current.split(spec.find).join(spec.with);
}

/** Quick type check with a clear message; SEO Bridge checks everything again (choices, media IDs) before saving. */
function checkType(def, value, where) {
  const fail = what => {
    throw new Error(where + ' must be ' + what + ' (' + def.type + ' field). Nothing was saved.');
  };
  if (value === null) {
    if (['group', 'repeater', 'flexible_content'].includes(def.type)) fail(def.type === 'group' ? 'an object of sub fields' : 'a list of rows');
    return;
  }
  if (TEXT_TYPES.has(def.type) && typeof value !== 'string') fail('text');
  if (['number', 'range'].includes(def.type) && !(typeof value === 'number' || (typeof value === 'string' && (value === '' || Number.isFinite(Number(value)))))) fail('a number');
  if (['image', 'file'].includes(def.type) && value !== '' && !isId(value)) fail('a media library ID (upload_image returns one)');
  if (def.type === 'gallery' && !(Array.isArray(value) && value.every(isId))) fail('a list of media library IDs');
  if (def.type === 'true_false' && ![true, false, 0, 1, '0', '1'].includes(value)) fail('true or false');
  if (def.type === 'group' && !isObject(value)) fail('an object of sub fields');
  if (['repeater', 'flexible_content'].includes(def.type) && !Array.isArray(value)) fail('a list of rows');
}

function leafValue(def, current, change, where) {
  const value = change.replace_text !== undefined
    ? (typeof current === 'string' ? replaceText(current, change.replace_text, where) : fail(where + ': replace_text works on text values only.'))
    : change.value;
  checkType(def, value, where);
  return value;
}

function fail(message) {
  throw new Error(message);
}

const subFieldNames = subs => Object.keys(subs).join(', ') || 'none';

/**
 * Set the value at tokens inside one field's value. Returns the new field value plus what was there before and after
 * at that path. Only the addressed value changes.
 */
function setAt(def, value, tokens, change, where) {
  if (!def.writable) fail(where + ': this is a ' + def.type + ' field, which cannot be changed with this tool.');
  if (!tokens.length) {
    const after = leafValue(def, value, change, where);
    return {value: after, before: value, after};
  }
  const [token, ...rest] = tokens;
  if (def.type === 'group') {
    if (token.index !== undefined) fail(where + ': group fields take .sub_field, not [' + token.index + '].');
    const subs = asObject(def.sub_fields);
    if (!subs[token.name]) fail(where + ': "' + token.name + '" is not a sub field here. Sub fields: ' + subFieldNames(subs) + '.');
    const group = {...asObject(value)};
    const inner = setAt(subs[token.name], group[token.name], rest, change, where);
    group[token.name] = inner.value;
    return {...inner, value: group};
  }
  if (def.type !== 'repeater' && def.type !== 'flexible_content') fail(where + ': a ' + def.type + ' field has no sub fields or rows.');
  if (token.index === undefined) fail(where + ': ' + def.type + ' fields take a row number such as [0] before the sub field.');
  const rows = Array.isArray(value) ? value.slice() : [];
  if (token.index >= rows.length) {
    fail(where + ': row ' + token.index + ' does not exist (this field has ' + rows.length + ' row(s), numbered from 0). To add or remove rows, set the whole field to the full list of rows.');
  }
  const row = asObject(rows[token.index]);
  const subs = def.type === 'repeater' ? asObject(def.sub_fields) : asObject(asObject(def.layouts)[row.acf_fc_layout]?.sub_fields);
  if (!rest.length) {
    // A whole row: the given sub fields are merged into it; the layout of a flexible content row cannot change.
    if (change.replace_text !== undefined) fail(where + ': replace_text needs the path of a text sub field.');
    if (!isObject(change.value)) fail(where + ': a row must be an object of sub fields.');
    const {acf_fc_layout: layout, ...values} = change.value;
    if (def.type === 'flexible_content' && layout !== undefined && layout !== row.acf_fc_layout) {
      fail(where + ': this row uses layout ' + row.acf_fc_layout + '; changing a row\'s layout is not supported. Set the whole field to the full list of rows instead.');
    }
    for (const name of Object.keys(values)) {
      if (!subs[name]) fail(where + ': "' + name + '" is not a sub field of this row. Sub fields: ' + subFieldNames(subs) + '.');
      checkType(subs[name], values[name], where + '.' + name);
    }
    const merged = {...row, ...values};
    rows[token.index] = merged;
    return {value: rows, before: row, after: merged};
  }
  const [subToken, ...deeper] = rest;
  if (subToken.index !== undefined) fail(where + ': after [' + token.index + '] give a sub field name.');
  if (!subs[subToken.name]) fail(where + ': "' + subToken.name + '" is not a sub field of row ' + token.index + '. Sub fields: ' + subFieldNames(subs) + '.');
  const inner = setAt(subs[subToken.name], row[subToken.name], deeper, change, where);
  rows[token.index] = {...row, [subToken.name]: inner.value};
  return {...inner, value: rows};
}

/** Compare values the way WordPress stores them: numbers and IDs as text, empty values alike. */
function canonical(value) {
  if (value === null || value === undefined || value === false || value === '') return '';
  if (value === true) return '1';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.length ? value.map(canonical) : '';
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return keys.length ? Object.fromEntries(keys.map(k => [k, canonical(value[k])])) : '';
  }
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

module.exports = {
  async inspect_fields(ctx, args) {
    const t = await target(ctx, args);
    await requireFieldsBridge(ctx, t.base);
    const item = await readItem(ctx, t);
    const data = item.mkt_fields;
    const fields = asObject(data.fields);
    const meta = asObject(data.meta);
    const paths = outlinePaths(fields);
    let note;
    if (!Object.keys(fields).length && !Object.keys(meta).length) {
      note = data.source === 'acf'
        ? 'No Advanced Custom Fields field group is shown on this ' + t.noun + ' (ACF location rules). Its visible text may be in the content (use list_blocks) or in the theme template.'
        : 'Advanced Custom Fields is not active on this site and no meta keys are listed as editable (Tools > MKT SEO Bridge).';
    }
    return ctx.result({
      ...about(t, item),
      source: data.source,
      ...(data.acf_version ? {acf_version: data.acf_version} : {}),
      bridge_version: data.version,
      paths,
      ...(paths.length >= MAX_PATHS ? {paths_truncated: true} : {}),
      fields,
      meta,
      ...(note ? {note} : {}),
    });
  },

  async update_fields(ctx, args) {
    checkText(args);
    const t = await target(ctx, args);
    if (t.kind === 'term' && args.expected_modified_gmt !== undefined) throw new Error('expected_modified_gmt applies to posts, pages and products; WordPress keeps no modified date for terms.');
    args.changes.forEach((change, i) => {
      const unknown = Object.keys(change).filter(key => !CHANGE_KEYS.has(key));
      if (unknown.length) fail('changes[' + i + ']: unknown key ' + unknown.join(', ') + '. Use {path, value}, {path, replace_text} or {meta, value}.');
      if ((change.path === undefined) === (change.meta === undefined)) fail('changes[' + i + '] needs either path (from inspect_fields) or meta.');
      if (Object.hasOwn(change, 'value') === (change.replace_text !== undefined)) fail('changes[' + i + '] needs either value or replace_text.');
      if (change.path !== undefined && typeof change.path !== 'string') fail('changes[' + i + '].path must be text.');
      if (change.meta !== undefined && typeof change.meta !== 'string') fail('changes[' + i + '].meta must be text.');
    });
    await requireFieldsBridge(ctx, t.base);
    const item = await readItem(ctx, t);
    const current = t.kind === 'term' ? decode(item.name) : raw(item.title);
    if (normalize(args.confirm_title) !== normalize(current)) {
      fail('confirm_title does not match the current ' + (t.kind === 'term' ? 'name' : 'title') + ' of ' + t.noun + ' ' + t.id + ' on site ' + ctx.site.site_id + '. Read it with inspect_fields and confirm the right site and item with the user.');
    }
    if (args.expected_modified_gmt !== undefined) {
      const stamp = text => String(text ?? '').replace(/(?:\.\d+)?(?:Z|\+00:00)$/i, '');
      if (stamp(args.expected_modified_gmt) !== stamp(item.modified_gmt)) {
        fail(t.noun[0].toUpperCase() + t.noun.slice(1) + ' ' + t.id + ' on site ' + ctx.site.site_id + ' changed since you read it (modified_gmt is now ' + item.modified_gmt + '). Read it again and check with the user; nothing was written.');
      }
    }
    if (item.status === 'trash') fail('This ' + t.noun + ' is in the trash. Restore it in WordPress first.');

    const fields = asObject(item.mkt_fields.fields);
    const meta = asObject(item.mkt_fields.meta);
    const nextFields = {};
    const nextMeta = {};
    const diff = [];
    args.changes.forEach((change, i) => {
      if (change.meta !== undefined) {
        const where = 'changes[' + i + '] (meta ' + change.meta + ')';
        const entry = meta[change.meta];
        if (!isObject(entry)) fail(where + ': this meta key is not editable on site ' + ctx.site.site_id + '. Editable: ' + (Object.keys(meta).join(', ') || 'none') + ' (an administrator lists them under Tools > MKT SEO Bridge).');
        if (!entry.writable) fail(where + ': this meta key holds structured data and is read-only.');
        const before = Object.hasOwn(nextMeta, change.meta) ? nextMeta[change.meta] : entry.value;
        const after = change.replace_text !== undefined ? replaceText(String(before ?? ''), change.replace_text, where) : change.value;
        if (after !== null && typeof after !== 'string') fail(where + ': the value must be text, or null to remove it.');
        nextMeta[change.meta] = after;
        diff.push({meta: change.meta, before, after});
        return;
      }
      const where = 'changes[' + i + '] (' + change.path + ')';
      const tokens = parsePath(change.path, where);
      const def = asObject(fields[tokens[0].name]);
      if (!fields[tokens[0].name]) fail(where + ': there is no custom field "' + tokens[0].name + '" on this ' + t.noun + '. Fields: ' + (Object.keys(fields).join(', ') || 'none') + '.');
      if (!Object.hasOwn(nextFields, tokens[0].name)) nextFields[tokens[0].name] = clone(def.value);
      const result = setAt(def, nextFields[tokens[0].name], tokens.slice(1), change, where);
      nextFields[tokens[0].name] = result.value;
      diff.push({path: change.path, before: result.before, after: result.after});
    });
    if (diff.every(d => same(d.before, d.after))) fail('The changes leave every field as it is. Nothing was saved.');

    const body = {mkt_fields: {...(Object.keys(nextFields).length ? {fields: nextFields} : {}), ...(Object.keys(nextMeta).length ? {meta: nextMeta} : {})}};
    const saved = await ctx.request(t.route, {method: 'POST', body});
    const savedFields = asObject(saved?.mkt_fields?.fields);
    const savedMeta = asObject(saved?.mkt_fields?.meta);
    const warnings = [];
    if (!isObject(saved?.mkt_fields)) {
      warnings.push('WordPress did not return the custom fields after saving. Check them with inspect_fields.');
    } else {
      const differ = [
        ...Object.keys(nextFields).filter(name => !same(asObject(savedFields[name]).value, nextFields[name])),
        ...Object.keys(nextMeta).filter(key => !same(asObject(savedMeta[key]).value, nextMeta[key])),
      ];
      if (differ.length) warnings.push('WordPress stored ' + differ.join(', ') + ' differently from what was sent (for example it removed HTML this account may not post). Check with inspect_fields.');
    }
    return ctx.result({
      ...about(t, saved),
      changes: diff,
      live: t.kind === 'term' || saved?.status === 'publish',
      restore: {
        changes: [
          ...Object.keys(nextFields).map(name => ({path: name, value: fields[name].value})),
          ...Object.keys(nextMeta).map(key => ({meta: key, value: meta[key].value})),
        ],
      },
      undo: 'WordPress keeps no revisions of custom fields. To undo, call update_fields again on the same site and ' + t.noun + ' with restore.changes.',
      ...(warnings.length ? {warning: warnings.join(' ')} : {}),
    });
  },
};
