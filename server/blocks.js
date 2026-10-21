'use strict';
// Block-safe editing of WordPress post content (the serialized block format).
//
// WordPress stores block-editor content as HTML with comment delimiters, for example
//   <!-- wp:paragraph --><p>Text</p><!-- /wp:paragraph -->
//   <!-- wp:acf/faq {"name":"acf/faq","data":{"question":"…"}} /-->
// The parser keeps the exact source position of every block, so an edit can change one piece of text (or one field of
// an ACF block) and write every other byte back unchanged. The block structure is re-checked before anything is saved.

// Same token as WordPress's block parser (class-wp-block-parser.php), without possessive quantifiers.
const TOKEN = /<!--\s+(\/)?wp:([a-z][a-z0-9_-]*\/)?([a-z][a-z0-9_-]*)\s+({(?:[^}]+|}+(?=})|(?!}\s+\/?-->)[\s\S])*?}\s+)?(\/)?-->/g;

/** Parse serialized content into a tree. Each node: {name, namespace, attrs, start, end, openEnd, closeStart, selfClosing, children}. */
function parse(content) {
  const root = {name: '#root', start: 0, end: content.length, openEnd: 0, closeStart: content.length, children: []};
  const stack = [root];
  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(content))) {
    const [token, closer, namespace = '', name, attrsText, voidMark] = match;
    const start = match.index;
    const end = start + token.length;
    const fullName = (namespace || 'core/') + name;
    if (closer) {
      const open = stack[stack.length - 1];
      if (open === root || open.name !== fullName) throw new Error('Unbalanced block markup: unexpected closing ' + fullName + ' at character ' + start + '.');
      open.closeStart = start;
      open.end = end;
      stack.pop();
      continue;
    }
    let attrs = {};
    if (attrsText) {
      try {
        attrs = JSON.parse(attrsText.trim());
      } catch {
        throw new Error('Block ' + fullName + ' at character ' + start + ' has unreadable attributes.');
      }
    }
    const node = {name: fullName, namespace, rawName: name, attrs, start, openEnd: end, end, closeStart: end, selfClosing: !!voidMark, children: []};
    stack[stack.length - 1].children.push(node);
    if (!voidMark) stack.push(node);
  }
  if (stack.length > 1) throw new Error('Unbalanced block markup: ' + stack[stack.length - 1].name + ' is never closed.');
  return root;
}

/** Character ranges inside a block that belong to the block itself (its HTML), not to nested blocks or delimiters. */
function ownRanges(node) {
  if (node.selfClosing) return [];
  const ranges = [];
  let cursor = node.openEnd;
  for (const child of node.children) {
    if (child.start > cursor) ranges.push([cursor, child.start]);
    cursor = child.end;
  }
  if (node.closeStart > cursor) ranges.push([cursor, node.closeStart]);
  return ranges;
}

/** Numbered entries: top-level blocks and non-empty classic HTML between them, with nested blocks as "2.0", "2.1". */
function entries(content, tree = parse(content)) {
  const list = [];
  const walk = (node, prefix) => {
    let index = 0;
    let cursor = node.openEnd;
    const pushHtml = (from, to) => {
      if (node === tree && content.slice(from, to).trim()) list.push({path: prefix + index++, name: 'html', node: {name: 'html', start: from, end: to, openEnd: from, closeStart: to, children: [], attrs: {}}});
    };
    for (const child of node.children) {
      pushHtml(cursor, child.start);
      const path = prefix + index++;
      list.push({path, name: child.name, node: child});
      walk(child, path + '.');
      cursor = child.end;
    }
    pushHtml(cursor, node.closeStart);
  };
  walk(tree, '');
  return list;
}

const stripTags = html => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, '\'').replace(/&#8220;|&#8221;|&quot;/g, '"').replace(/\s+/g, ' ').trim();
const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

/** A compact outline for Claude: one line per block with its text, or its ACF data fields. */
function outline(content, {maxEntries = 300, maxText = 110} = {}) {
  const tree = parse(content);
  const list = entries(content, tree);
  const items = list.slice(0, maxEntries).map(({path, name, node}) => {
    const own = ownRanges(node).map(([a, b]) => content.slice(a, b)).join(' ');
    const item = {block: path, name};
    const text = stripTags(name === 'html' ? content.slice(node.start, node.end) : own);
    if (text) item.text = clip(text, maxText);
    if (node.children.length) item.inner_blocks = node.children.length;
    const data = node.attrs && node.attrs.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      // ACF block fields: "name" holds the value, "_name" the field key.
      item.fields = Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, typeof v === 'string' ? clip(stripTags(v), 80) : v]));
    }
    return item;
  });
  return {blocks: items, total: list.length, truncated: list.length > maxEntries};
}

/** Serialize attributes exactly as WordPress does (serialize_block_attributes), so delimiters stay valid. */
function serializeAttrs(attrs) {
  return JSON.stringify(attrs)
    .replace(/--/g, '\\u002d\\u002d')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\\"/g, '\\u0022');
}

function opener(node, attrs) {
  return '<!-- wp:' + node.namespace + node.rawName + (Object.keys(attrs).length ? ' ' + serializeAttrs(attrs) : '') + ' ' + (node.selfClosing ? '/' : '') + '-->';
}

const escapeHtml = text => text.replace(/&(?![a-z]+;|#\d+;|#x[0-9a-f]+;)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Find every occurrence of `find` inside the given ranges. Retries with HTML-escaped text (e.g. "&" as "&amp;"). */
function findIn(content, ranges, find, replacement) {
  const attempt = (needle, value) => {
    const hits = [];
    for (const [a, b] of ranges) {
      let at = content.indexOf(needle, a);
      while (at !== -1 && at + needle.length <= b) {
        hits.push({start: at, end: at + needle.length, replacement: value});
        at = content.indexOf(needle, at + needle.length);
      }
    }
    return hits;
  };
  let hits = attempt(find, replacement);
  if (!hits.length && escapeHtml(find) !== find) hits = attempt(escapeHtml(find), escapeHtml(replacement));
  return hits;
}

const signature = tree => {
  const names = [];
  const walk = node => node.children.forEach(child => {
    names.push(child.name + '(' + child.children.length + ')');
    walk(child);
  });
  walk(tree);
  return names.join(' ');
};

/**
 * Apply a list of changes and return {content, diff}. Throws (and changes nothing) on any ambiguity.
 * Change forms:
 *   {block: '3', replace_text: {find, with, all}}  text inside one block (not its nested blocks)
 *   {replace_text: {find, with, all}}              text anywhere in the content, outside block delimiters
 *   {block: '5', acf_data: {field: value}}         fields of an ACF block's data (existing fields only)
 */
function applyChanges(content, changes) {
  if (!Array.isArray(changes) || !changes.length) throw new Error('changes must be a non-empty list.');
  if (changes.length > 50) throw new Error('At most 50 changes per call.');
  const tree = parse(content);
  const byPath = new Map(entries(content, tree).map(e => [e.path, e.node]));
  const allRanges = [];
  const collect = node => {
    allRanges.push(...ownRanges(node));
    node.children.forEach(collect);
  };
  collect(tree);
  const edits = [];
  const diff = [];

  changes.forEach((change, i) => {
    const label = 'Change ' + (i + 1);
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error(label + ' must be an object.');
    const keys = Object.keys(change);
    const unknown = keys.filter(k => !['block', 'replace_text', 'acf_data'].includes(k));
    if (unknown.length) throw new Error(label + ' has unknown keys: ' + unknown.join(', ') + '.');
    if (!!change.replace_text === !!change.acf_data) throw new Error(label + ' needs exactly one of replace_text or acf_data.');
    let node = null;
    if (change.block !== undefined) {
      node = byPath.get(String(change.block));
      if (!node) throw new Error(label + ': there is no block ' + change.block + '. Use list_blocks to see the block numbers.');
    }

    if (change.replace_text) {
      const {find, with: replacement, all = false, ...extra} = change.replace_text;
      if (Object.keys(extra).length) throw new Error(label + ': replace_text takes find, with and all only.');
      if (typeof find !== 'string' || !find) throw new Error(label + ': replace_text.find must be non-empty text.');
      if (typeof replacement !== 'string') throw new Error(label + ': replace_text.with must be text.');
      if (/<!--|-->/.test(find + replacement)) throw new Error(label + ': text may not contain block comment markers (<!-- or -->).');
      const ranges = node ? (node.name === 'html' ? [[node.start, node.end]] : ownRanges(node)) : allRanges;
      const hits = findIn(content, ranges, find, replacement);
      if (!hits.length) {
        throw new Error(label + ': "' + clip(find, 60) + '" was not found' + (node ? ' in block ' + change.block + ' (text in its nested blocks or ACF fields must be targeted there)' : '') + '. Nothing was changed.');
      }
      if (hits.length > 1 && all !== true) throw new Error(label + ': "' + clip(find, 60) + '" appears ' + hits.length + ' times' + (node ? ' in block ' + change.block : '') + '. Give more surrounding text, a block number, or all:true. Nothing was changed.');
      for (const hit of hits) {
        edits.push(hit);
        diff.push({change: i + 1, block: node ? String(change.block) : undefined, before: clip(content.slice(Math.max(0, hit.start - 40), hit.end + 40), 200), after: clip(content.slice(Math.max(0, hit.start - 40), hit.start) + hit.replacement + content.slice(hit.end, hit.end + 40), 200)});
      }
    } else {
      if (!node || node.name === 'html') throw new Error(label + ': acf_data needs the number of an ACF block.');
      const data = node.attrs && node.attrs.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(label + ': block ' + change.block + ' (' + node.name + ') has no ACF data.');
      if (!change.acf_data || typeof change.acf_data !== 'object' || Array.isArray(change.acf_data)) throw new Error(label + ': acf_data must be an object of field: value.');
      const next = {...node.attrs, data: {...data}};
      for (const [field, value] of Object.entries(change.acf_data)) {
        if (field.startsWith('_') || !Object.hasOwn(data, field)) {
          throw new Error(label + ': block ' + change.block + ' has no field "' + field + '". Fields: ' + Object.keys(data).filter(k => !k.startsWith('_')).join(', ') + '.');
        }
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new Error(label + ': field "' + field + '" must be text, a number or true/false.');
        diff.push({change: i + 1, block: String(change.block), field, before: data[field], after: value});
        next.data[field] = value;
      }
      edits.push({start: node.start, end: node.openEnd, replacement: opener(node, next)});
    }
  });

  // Edits must not overlap (for example two changes touching the same text).
  edits.sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].start < edits[i - 1].end) throw new Error('Two changes touch the same text. Combine them into one change. Nothing was changed.');
  }
  let result = content;
  for (const edit of [...edits].reverse()) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);

  // The edited content must parse to exactly the same block structure.
  const after = parse(result);
  if (signature(after) !== signature(tree)) throw new Error('The change would alter the block structure. Nothing was changed.');
  return {content: result, diff, edits: edits.length};
}

module.exports = {parse, outline, applyChanges, serializeAttrs};
