'use strict';
// Page builders, and what an edit to the post content does to a page built with one.
//
// Builders that keep the layout in their own post meta (Elementor, Bricks, Beaver Builder, Breakdance, Oxygen) leave
// post_content as a fallback copy: changing it does not change the page, and the builder overwrites it on its next
// save. Builders that keep the layout as shortcodes or blocks inside post_content (WPBakery, Divi, Avada) are broken
// by a full content replacement, but text changes inside them (edit_blocks replace_text) keep the layout.
//
// SEO Bridge 1.4.0+ reports the builder from its own meta (the mkt_builder field), which is exact. Without it the
// stored and rendered content and the page template are checked, which catches most but not all builder pages.

const BUILDERS = {
  elementor: {name: 'Elementor', storage: 'meta'},
  bricks: {name: 'Bricks', storage: 'meta'},
  'beaver-builder': {name: 'Beaver Builder', storage: 'meta'},
  breakdance: {name: 'Breakdance', storage: 'meta'},
  oxygen: {name: 'Oxygen', storage: 'meta'},
  wpbakery: {name: 'WPBakery Page Builder', storage: 'content'},
  divi: {name: 'Divi', storage: 'content'},
  avada: {name: 'Avada Fusion Builder', storage: 'content'},
};

// Shortcodes and blocks a builder writes into post_content.
const RAW_MARKERS = [
  ['wpbakery', /\[vc_row[\s\]]/],
  ['divi', /\[et_pb_section[\s\]]|<!-- wp:divi\//],
  ['avada', /\[fusion_builder_container[\s\]]/],
  ['oxygen', /\[ct_section[\s\]]/],
];
// Markup a builder adds when WordPress renders the content.
const RENDERED_MARKERS = [
  ['elementor', /\bdata-elementor-type=|class="elementor elementor-\d+/],
  ['beaver-builder', /\bfl-builder-content\b/],
  ['bricks', /\bbrxe-[a-z0-9]/],
  ['breakdance', /class="[^"]*\bbreakdance\b/],
];

const describe = id => ({id, ...BUILDERS[id]});

/** The builder that owns this post's layout, or null. post is a WordPress post object read with context=edit. */
function detectBuilder(post) {
  const bridged = post?.mkt_builder;
  if (bridged && typeof bridged === 'object' && typeof bridged.id === 'string') {
    return BUILDERS[bridged.id] ? {...describe(bridged.id), source: 'seo-bridge'} : {id: bridged.id, name: String(bridged.name || bridged.id), storage: bridged.storage === 'content' ? 'content' : 'meta', source: 'seo-bridge'};
  }
  // The bridge answered and found no builder.
  if (post && Object.hasOwn(post, 'mkt_builder')) return null;
  if (post?.meta?._elementor_edit_mode === 'builder' || /^elementor_(?:canvas|header_footer|theme)$/.test(String(post?.template || ''))) {
    return {...describe('elementor'), source: 'detected'};
  }
  const rawContent = typeof post?.content?.raw === 'string' ? post.content.raw : '';
  const rendered = typeof post?.content?.rendered === 'string' ? post.content.rendered : '';
  for (const [id, pattern] of RAW_MARKERS) if (pattern.test(rawContent)) return {...describe(id), source: 'detected'};
  for (const [id, pattern] of RENDERED_MARKERS) if (pattern.test(rendered)) return {...describe(id), source: 'detected'};
  return null;
}

/**
 * Refuse a content change that would not work on a builder page. wholeContent is true for a full replacement
 * (update_draft, edit_published_post) and false for text changes inside the stored content (edit_blocks).
 */
function requireNotBuilder(ctx, post, kind, {wholeContent, allow}) {
  const builder = detectBuilder(post);
  if (!builder || allow) return builder;
  const which = kind[0].toUpperCase() + kind.slice(1) + ' ' + post.id + ' on site ' + ctx.site.site_id + ' is built with ' + builder.name;
  const others = ' Title, slug, excerpt, featured image, categories, tags, author and SEO fields can still be changed here.';
  const override = ' Pass allow_page_builder: true only if the user explicitly wants this anyway.';
  if (builder.storage === 'meta') {
    throw new Error(which + ', which keeps the layout in its own data: changing the post content here would not change the page, and ' + builder.name + ' would overwrite it on its next save. Edit the content in ' + builder.name + (builder.id === 'elementor' ? ' (or with get_elementor_layout and update_elementor_layout, which need SEO Bridge 1.5.0)' : '') + '.' + others + override + ' Nothing was saved.');
  }
  if (wholeContent) {
    throw new Error(which + ', whose layout is stored in the content: replacing the whole content would remove that layout. Use edit_blocks with replace_text to change text inside it, or edit it in ' + builder.name + '.' + others + override + ' Nothing was saved.');
  }
  return builder;
}

module.exports = {detectBuilder, requireNotBuilder};
