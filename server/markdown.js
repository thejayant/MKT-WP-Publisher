'use strict';
// Small, dependency-free Markdown to HTML converter for post content.
// Covers what blog drafts use: headings, paragraphs, emphasis, links, images, lists (nested),
// blockquotes, fenced code, horizontal rules, GFM pipe tables and raw HTML blocks.
// Output is plain HTML; the block editor shows it as a Classic block that can be converted to blocks.

const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = s => s.replace(/&(?![a-zA-Z]+;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// Allow web, mail, phone, relative and fragment URLs; drop javascript:, data: and other schemes.
const safeUrl = u => {
  const url = u.trim();
  if (/^(?:https?:|mailto:|tel:|\/|#|\.{0,2}\/)/i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return null;
};

function inline(text) {
  const slots = [];
  const hold = html => '\u0000' + (slots.push(html) - 1) + '\u0000';
  let s = text;
  // Backslash escapes and code spans first, so their contents are not formatted.
  s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|~<>])/g, (_, ch) => hold(escapeHtml(ch)));
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold('<code>' + escapeHtml(code.trim()) + '</code>'));
  // URLs may contain one level of balanced parentheses, e.g. https://en.wikipedia.org/wiki/Foo_(bar).
  s = s.replace(/!\[([^\]]*)\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))+)>?(?:\s+"([^"]*)")?\s*\)/g, (m, alt, src, title) => {
    const url = safeUrl(src);
    return url === null ? hold(escapeHtml(alt)) : hold('<img src="' + escapeAttr(url) + '" alt="' + escapeAttr(alt) + '"' + (title ? ' title="' + escapeAttr(title) + '"' : '') + ' />');
  });
  s = s.replace(/\[([^\]]+)\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))+)>?(?:\s+"([^"]*)")?\s*\)/g, (m, label, href, title) => {
    const url = safeUrl(href);
    return url === null ? label : hold('<a href="' + escapeAttr(url) + '"' + (title ? ' title="' + escapeAttr(title) + '"' : '') + '>') + label + hold('</a>');
  });
  s = s.replace(/<((?:https?:\/\/|mailto:)[^\s>]+)>/g, (_, url) => hold('<a href="' + escapeAttr(url) + '">' + escapeHtml(url.replace(/^mailto:/, '')) + '</a>'));
  // Inline HTML tags pass through untouched; WordPress filters them for accounts without unfiltered_html.
  s = s.replace(/<\/?[a-zA-Z][^<>]*>|<!--[\s\S]*?-->/g, tag => hold(tag));
  s = s.replace(/&(?![a-zA-Z]+;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  s = s.replace(/\*(?=\S)([\s\S]*?\S)\*/g, '<em>$1</em>');
  s = s.replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  // Hard breaks become <br />; soft line breaks become spaces, because WordPress's wpautop would turn them into <br />.
  s = s.replace(/ {2,}\n|\\\n/g, '<br />').replace(/[ \t]*\n[ \t]*/g, ' ');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i]).replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i]);
}

const blockTag = /^<\/?(?:address|article|aside|blockquote|details|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|iframe|main|nav|ol|p|pre|section|table|ul|video|audio|script|style|!--)[\s>/]/i;
const listItem = /^( {0,3})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const splitRow = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim());

function blocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^ {0,3}(```+|~~~+)\s*([\w+-]*)/))) {
      const fence = m[1], code = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence)) code.push(lines[i++]);
      i++;
      out.push('<pre><code' + (m[2] ? ' class="language-' + escapeAttr(m[2]) + '"' : '') + '>' + escapeHtml(code.join('\n')) + '</code></pre>');
      continue;
    }
    if ((m = line.match(/^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/))) {
      out.push('<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>');
      i++;
      continue;
    }
    if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) { out.push('<hr />'); i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const quote = [];
      while (i < lines.length && lines[i].trim() && /^ {0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      out.push('<blockquote>' + blocks(quote) + '</blockquote>');
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line), align = splitRow(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '');
      const cell = (tag, text, n) => '<' + tag + (align[n] ? ' style="text-align:' + align[n] + '"' : '') + '>' + inline(text || '') + '</' + tag + '>';
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      out.push('<table><thead><tr>' + head.map((h, n) => cell('th', h, n)).join('') + '</tr></thead>' + (rows.length ? '<tbody>' + rows.map(r => '<tr>' + head.map((_, n) => cell('td', r[n], n)).join('') + '</tr>').join('') + '</tbody>' : '') + '</table>');
      continue;
    }
    if ((m = line.match(listItem))) {
      const ordered = /\d/.test(m[2]), items = [];
      let loose = false;
      while (i < lines.length) {
        const item = lines[i].match(listItem);
        if (!item || /\d/.test(item[2]) !== ordered || item[1].length > m[1].length + 1) break;
        const body = [item[3]];
        const indent = item[1].length + item[2].length + 1;
        i++;
        while (i < lines.length) {
          if (!lines[i].trim()) {
            const next = lines[i + 1];
            if (next !== undefined && /^\s{2,}\S/.test(next) && !(next.match(listItem) && next.match(listItem)[1].length <= m[1].length)) { body.push(''); loose = true; i++; continue; }
            break;
          }
          const sub = lines[i].match(listItem);
          if (sub && sub[1].length <= m[1].length) break;
          if (!/^\s/.test(lines[i]) && !sub) { body[body.length - 1] += '\n' + lines[i]; i++; continue; }
          body.push(lines[i].replace(new RegExp('^ {0,' + Math.max(indent, 2) + '}'), ''));
          i++;
        }
        items.push(body);
        // A blank line followed by another item of the same list makes the list loose (items wrapped in <p>).
        const next = i < lines.length && !lines[i].trim() && lines[i + 1] ? lines[i + 1].match(listItem) : null;
        if (next && next[1].length === m[1].length && /\d/.test(next[2]) === ordered) { loose = true; i++; }
      }
      const tag = ordered ? 'ol' : 'ul';
      const start = ordered && parseInt(m[2], 10) !== 1 ? ' start="' + parseInt(m[2], 10) + '"' : '';
      out.push('<' + tag + start + '>' + items.map(body => {
        const html = blocks(body);
        return '<li>' + (loose ? html : html.replace(/^<p>([\s\S]*?)<\/p>/, '$1')) + '</li>';
      }).join('') + '</' + tag + '>');
      continue;
    }
    if (blockTag.test(line.trimStart())) {
      const html = [];
      while (i < lines.length && lines[i].trim()) html.push(lines[i++]);
      out.push(html.join('\n'));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^ {0,3}(#{1,6}[ \t]|>|```|~~~)/.test(lines[i]) && !/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(lines[i]) && !(para.length && listItem.test(lines[i]))) para.push(lines[i++]);
    out.push('<p>' + inline(para.map(l => l.replace(/^ {1,3}/, '')).join('\n')) + '</p>');
  }
  return out.join('\n');
}

function markdownToHtml(md) {
  return blocks(String(md).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}

module.exports = {markdownToHtml};
