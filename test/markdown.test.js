'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {makeService, tools, VERSION} = require('../server/service.js');
const {sites, env, mock, runChild, slot, seoSchema} = require('./helpers.js');
const {markdownToHtml} = require('../server/markdown.js');

test('F12: markdown converter covers common blog formatting and drops unsafe links',()=>{
 const cases=[
  ['# Title *one*','<h1>Title <em>one</em></h1>'],
  ['Line one\nline two','<p>Line one line two</p>'],
  ['Hard  \nbreak','<p>Hard<br />break</p>'],
  ['Back\\\nslash','<p>Back<br />slash</p>'],
  ['AT&T and &amp; and `a < b`','<p>AT&amp;T and &amp; and <code>a &lt; b</code></p>'],
  ['[Site](https://example.com "Home") ![Alt "x"](/img.png)','<p><a href="https://example.com" title="Home">Site</a> <img src="/img.png" alt="Alt &quot;x&quot;" /></p>'],
  ['[bad](javascript:alert(1)) [w](https://en.wikipedia.org/wiki/A_(b))','<p>bad <a href="https://en.wikipedia.org/wiki/A_(b)">w</a></p>'],
  ['- a\n- b\n  - c\n- d','<ul><li>a</li><li>b\n<ul><li>c</li></ul></li><li>d</li></ul>'],
  ['- a\n\n- b','<ul><li><p>a</p></li><li><p>b</p></li></ul>'],
  ['3. x\n4. y','<ol start="3"><li>x</li><li>y</li></ol>'],
  ['> quote\n> more','<blockquote><p>quote more</p></blockquote>'],
  ['```js\nif (a < b) {}\n```','<pre><code class="language-js">if (a &lt; b) {}</code></pre>'],
  ['| A | B |\n|:--|--:|\n| 1 | 2 |','<table><thead><tr><th style="text-align:left">A</th><th style="text-align:right">B</th></tr></thead><tbody><tr><td style="text-align:left">1</td><td style="text-align:right">2</td></tr></tbody></table>'],
  ['---','<hr />'],
  ['<div class="cta">Raw</div>','<div class="cta">Raw</div>'],
  ['~~old~~ snake_case_name __strong__','<p><del>old</del> snake_case_name <strong>strong</strong></p>'],
  ['Text\r\n\r\nNext','<p>Text</p>\n<p>Next</p>']
 ];
 for(const [md,html] of cases)assert.equal(markdownToHtml(md),html,md);
});
