'use strict';
// What the agent should know about a site before working on it: the site context (theme, plugins, SEO plugin, page
// builders, post types, access), the block types it has registered, and the theme's brand styles (colours, fonts,
// sizes). All read-only. Every lookup beyond the first is optional: an account that cannot read plugins or settings
// still gets everything else, with a note saying what was not available.

// Active plugins, recognised by their folder (from /wp/v2/plugins, administrators only) or, for any role, by the
// REST namespace they add.
const PLUGINS = [
  {group: 'seo', id: 'yoast', name: 'Yoast SEO', folder: 'wordpress-seo', namespace: 'yoast/v1'},
  {group: 'seo', id: 'rank-math', name: 'Rank Math', folder: 'seo-by-rank-math', namespace: 'rankmath/v1'},
  {group: 'seo', id: 'aioseo', name: 'All in One SEO', folder: 'all-in-one-seo-pack', namespace: 'aioseo/v1'},
  {group: 'seo', id: 'seopress', name: 'SEOPress', folder: 'wp-seopress', namespace: 'seopress/v1'},
  {group: 'store', id: 'woocommerce', name: 'WooCommerce', folder: 'woocommerce', namespace: 'wc/v3'},
  {group: 'fields', id: 'acf', name: 'Advanced Custom Fields', folder: /^advanced-custom-fields(?:-pro)?$/},
  {group: 'fields', id: 'meta-box', name: 'Meta Box', folder: 'meta-box'},
  {group: 'fields', id: 'pods', name: 'Pods', folder: 'pods', namespace: 'pods/v1'},
  {group: 'page_builders', id: 'elementor', name: 'Elementor', folder: 'elementor', namespace: 'elementor/v1'},
  {group: 'page_builders', id: 'beaver-builder', name: 'Beaver Builder', folder: /^(?:bb-plugin|beaver-builder-lite-version)$/},
  {group: 'page_builders', id: 'wpbakery', name: 'WPBakery Page Builder', folder: 'js_composer'},
  {group: 'page_builders', id: 'divi', name: 'Divi Builder', folder: 'divi-builder'},
  {group: 'page_builders', id: 'breakdance', name: 'Breakdance', folder: 'breakdance'},
  {group: 'page_builders', id: 'oxygen', name: 'Oxygen', folder: 'oxygen'},
  {group: 'page_builders', id: 'avada', name: 'Avada Fusion Builder', folder: 'fusion-builder'},
  {group: 'multilingual', id: 'wpml', name: 'WPML', folder: 'sitepress-multilingual-cms'},
  {group: 'multilingual', id: 'polylang', name: 'Polylang', folder: /^polylang(?:-pro)?$/, namespace: 'pll/v1'},
  {group: 'multilingual', id: 'translatepress', name: 'TranslatePress', folder: 'translatepress-multilingual'},
  {group: 'multilingual', id: 'weglot', name: 'Weglot', folder: 'weglot'},
  {group: 'forms', id: 'contact-form-7', name: 'Contact Form 7', folder: 'contact-form-7', namespace: 'contact-form-7/v1'},
  {group: 'forms', id: 'wpforms', name: 'WPForms', folder: /^wpforms(?:-lite)?$/},
  {group: 'forms', id: 'gravity-forms', name: 'Gravity Forms', folder: 'gravityforms', namespace: 'gf/v2'},
  {group: 'forms', id: 'fluent-forms', name: 'Fluent Forms', folder: 'fluentform'},
  {group: 'cache', id: 'litespeed-cache', name: 'LiteSpeed Cache', folder: 'litespeed-cache', namespace: 'litespeed/v1'},
  {group: 'cache', id: 'wp-rocket', name: 'WP Rocket', folder: 'wp-rocket'},
  {group: 'cache', id: 'w3-total-cache', name: 'W3 Total Cache', folder: 'w3-total-cache'},
  {group: 'cache', id: 'wp-super-cache', name: 'WP Super Cache', folder: 'wp-super-cache'},
  {group: 'cache', id: 'wp-fastest-cache', name: 'WP Fastest Cache', folder: 'wp-fastest-cache'},
];
// Themes that are page builders themselves (matched on the parent theme's folder).
const {parse, entries} = require('../blocks.js');

const BUILDER_THEMES = {divi: 'Divi', bricks: 'Bricks', avada: 'Avada Fusion Builder', oxygen: 'Oxygen'};
const INTERNAL_TYPES = new Set(['attachment', 'nav_menu_item', 'wp_block', 'wp_template', 'wp_template_part', 'wp_global_styles', 'wp_navigation', 'wp_font_family', 'wp_font_face']);
const BLOCK_NAME = /^[a-z0-9-]+\/[a-z0-9-]+$/;
// Attributes WordPress adds through block supports and core features; not always in the REST schema, never reported.
const GLOBAL_ATTRIBUTES = new Set(['className', 'style', 'lock', 'metadata', 'anchor', 'align', 'backgroundColor', 'textColor', 'gradient', 'fontSize', 'fontFamily', 'borderColor', 'layout', 'shadow', 'templateLock', 'allowedBlocks']);
const JSON_TYPES = {
  string: v => typeof v === 'string',
  'rich-text': v => typeof v === 'string',
  number: v => typeof v === 'number' && Number.isFinite(v),
  integer: v => Number.isSafeInteger(v),
  boolean: v => typeof v === 'boolean',
  object: v => !!v && typeof v === 'object' && !Array.isArray(v),
  array: v => Array.isArray(v),
  null: v => v === null,
};

/** check_blocks: one block's comment attributes against its registered attributes. */
function checkAttributes(type, attrs, where, problems, warnings) {
  const defs = type.attributes && typeof type.attributes === 'object' ? type.attributes : {};
  for (const [key, value] of Object.entries(attrs)) {
    const def = defs[key];
    if (!def) {
      if (!GLOBAL_ATTRIBUTES.has(key)) warnings.push(where + ': attribute "' + key + '" is not registered for ' + type.name + '; the editor ignores it.');
      continue;
    }
    if (def.source) warnings.push(where + ': attribute "' + key + '" is read from the block\'s HTML (' + def.source + '), so the value in the block comment is ignored. Change the HTML instead.');
    const types = def.type === undefined ? [] : [].concat(def.type);
    if (types.length && !types.some(t => !JSON_TYPES[t] || JSON_TYPES[t](value))) {
      problems.push(where + ': attribute "' + key + '" must be ' + types.join(' or ') + '.');
      continue;
    }
    if (Array.isArray(def.enum) && !def.enum.includes(value)) problems.push(where + ': attribute "' + key + '" must be one of: ' + def.enum.map(String).join(', ') + '.');
  }
}

const clip = (text, max) => {
  const value = String(text ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
};

/** Run optional lookups side by side; a failure becomes null plus a note instead of failing the whole tool. */
async function optional(lookups, notes) {
  const names = Object.keys(lookups);
  const settled = await Promise.allSettled(names.map(name => lookups[name]()));
  const out = {};
  settled.forEach((result, i) => {
    out[names[i]] = result.status === 'fulfilled' ? result.value : null;
    if (result.status === 'rejected' && notes[names[i]]) notes.list.push(notes[names[i]] + (result.reason?.status ? ' (HTTP ' + result.reason.status + ')' : ''));
  });
  return out;
}

const matches = (rule, folder) => (rule instanceof RegExp ? rule.test(folder) : rule === folder);

/** Plugins found on the site, grouped. From the plugin list when readable, else from REST namespaces. */
function detectPlugins(activePlugins, namespaces, theme) {
  const found = {seo: [], store: [], fields: [], page_builders: [], multilingual: [], forms: [], cache: []};
  for (const rule of PLUGINS) {
    const byFolder = activePlugins?.some(p => matches(rule.folder, String(p.plugin || '').split('/')[0]));
    const byNamespace = rule.namespace && namespaces.includes(rule.namespace);
    if (byFolder || byNamespace) found[rule.group].push({id: rule.id, name: rule.name});
  }
  const parent = String(theme?.template || '').toLowerCase();
  if (BUILDER_THEMES[parent] && !found.page_builders.some(b => b.name === BUILDER_THEMES[parent])) {
    found.page_builders.push({id: parent, name: BUILDER_THEMES[parent], via: 'theme'});
  }
  return found;
}

/** WordPress preset references ("var:preset|color|primary") as the CSS variable the theme defines. */
const cssValue = value => (typeof value === 'string' ? value.replace(/^var:preset\|([a-z0-9-]+)\|([a-z0-9-]+)$/i, 'var(--wp--preset--$1--$2)') : value);

/** Presets from theme.json (an array) or from saved global styles ({theme, default, custom}). */
function presets(value, origin = 'theme') {
  if (Array.isArray(value)) return value.map(item => ({...item, origin}));
  if (!value || typeof value !== 'object') return [];
  return ['default', 'theme', 'custom'].flatMap(key => (Array.isArray(value[key]) ? value[key].map(item => ({...item, origin: key})) : []));
}

/** Theme presets with the user's saved ones on top (same slug: the user's wins). */
function mergePresets(themeValue, userValue) {
  const merged = new Map();
  for (const item of [...presets(themeValue), ...presets(userValue, 'custom')]) {
    if (item && typeof item.slug === 'string') merged.set(item.slug, item);
  }
  return [...merged.values()];
}

module.exports = {
  /** One call that tells the agent what this site is, what is installed, and what it may do here. */
  async get_site_context(ctx) {
    const notes = {
      list: [],
      settings: 'Site settings need an administrator account',
      plugins: 'The plugin list needs an administrator account, so plugins were detected from the REST API only and some may be missing',
      theme: 'The active theme could not be read',
      bridge: 'The SEO Bridge check failed',
      types: 'Post types could not be read',
    };
    const index = await ctx.request('', {namespace: ''});
    const lookups = await optional({
      me: () => ctx.request('/users/me?context=edit'),
      settings: () => ctx.request('/settings'),
      plugins: () => ctx.request('/plugins?status=active&_fields=plugin,name,version'),
      theme: () => ctx.request('/themes?status=active&_fields=stylesheet,template,name,version,is_block_theme').then(list => (Array.isArray(list) ? list[0] : null)),
      bridge: () => ctx.request('/posts', {method: 'OPTIONS'}),
      types: () => ctx.request('/types?context=edit'),
    }, notes);
    const namespaces = Array.isArray(index?.namespaces) ? index.namespaces : [];
    const plugins = detectPlugins(Array.isArray(lookups.plugins) ? lookups.plugins : null, namespaces, lookups.theme);
    const bridgeProps = lookups.bridge?.schema?.properties || {};
    const seoProps = bridgeProps.mkt_seo?.properties;
    const bridge = seoProps
      ? {installed: true, version: seoProps.version?.enum?.[0] || '1.0.0', seo_plugin: seoProps.plugin?.enum?.[0] || 'none', custom_fields: !!bridgeProps.mkt_fields, page_builder_detection: !!bridgeProps.mkt_builder}
      : {installed: false};
    const can = lookups.me?.capabilities || {};
    const theme = lookups.theme;
    const name = theme?.name && typeof theme.name === 'object' ? theme.name.raw ?? theme.name.rendered : theme?.name;
    const readOnly = ctx.readOnly === true;

    const guidance = [];
    if (readOnly) guidance.push('This website is connected read-only: read and preview only. Every tool that writes to it is refused.');
    if (plugins.page_builders.length) guidance.push('Page builder(s) active: ' + plugins.page_builders.map(b => b.name).join(', ') + '. get_post and list_blocks report page_builder for builder pages; content edits on them are refused, so edit those in the builder. Title, slug, SEO, categories and featured image can still change here.');
    if (theme?.is_block_theme) guidance.push('Block theme: call get_brand_styles and use the theme\'s preset colours and font sizes (slugs) in block attributes instead of fixed values.');
    if (!plugins.seo.length) guidance.push('No SEO plugin detected: the seo fields cannot be set on this site.');
    else if (!bridge.installed) guidance.push('Install the MKT Publisher SEO Bridge plugin to set SEO titles, descriptions, focus keywords and canonical URLs.');
    if (plugins.multilingual.length) guidance.push('Multilingual plugin active (' + plugins.multilingual.map(p => p.name).join(', ') + '): check which language a post is in before editing it.');
    if (plugins.cache.length) guidance.push('Page cache active (' + plugins.cache.map(p => p.name).join(', ') + '): a published change can take a while to show to visitors until the cache refreshes.');
    guidance.push('Use list_block_types and get_block_type before writing blocks you have not used on this site. Preview changes to live posts with preview_edit (or stage_edit for review in WordPress) before applying them.');

    return ctx.result({
      site: {
        name: index?.name,
        description: index?.description,
        url: index?.home || ctx.site.site_url,
        language: lookups.settings?.language || undefined,
        timezone: lookups.settings?.timezone || index?.timezone_string || undefined,
        gmt_offset: index?.gmt_offset,
        rest_api_style: ctx.usesPlainPermalinks() ? 'plain (?rest_route=)' : 'pretty (/wp-json)',
      },
      access: {
        mode: readOnly ? 'read_only' : 'full',
        user: lookups.me ? {user_id: lookups.me.id, name: lookups.me.name, roles: lookups.me.roles} : undefined,
        can_publish: !!can.publish_posts,
        can_upload: !!can.upload_files,
        can_edit_others: !!can.edit_others_posts,
        is_administrator: !!can.manage_options,
      },
      theme: theme ? {name, stylesheet: theme.stylesheet, parent: theme.template !== theme.stylesheet ? theme.template : undefined, version: theme.version, block_theme: !!theme.is_block_theme} : null,
      plugins: {
        detected_from: Array.isArray(lookups.plugins) ? 'plugin list' : 'REST API namespaces',
        ...plugins,
        ...(Array.isArray(lookups.plugins) ? {active: lookups.plugins.map(p => ({name: clip(p.name, 80), version: p.version})).slice(0, 100)} : {}),
      },
      seo_bridge: bridge,
      post_types: lookups.types
        ? Object.values(lookups.types).filter(t => t.rest_base && !INTERNAL_TYPES.has(t.slug)).map(t => ({post_type: t.slug, name: t.name, hierarchical: !!t.hierarchical}))
        : undefined,
      guidance,
      ...(notes.list.length ? {notes: notes.list} : {}),
    });
  },

  /** Block types registered on the site, compact. Filter by namespace (core, woocommerce, acf…), category or text. */
  async list_block_types(ctx, args) {
    if (args.namespace !== undefined && !/^[a-z0-9-]+$/.test(args.namespace)) throw new Error('namespace must be a block namespace such as core, woocommerce or acf.');
    const route = '/block-types' + (args.namespace ? '/' + args.namespace : '') + '?_fields=name,title,description,category,parent,ancestor,is_dynamic';
    const list = await ctx.request(route);
    const search = String(args.search || '').toLowerCase();
    const items = (Array.isArray(list) ? list : [])
      .filter(b => !args.category || b.category === args.category)
      .filter(b => !search || [b.name, b.title, b.description].some(text => String(text || '').toLowerCase().includes(search)))
      .map(b => ({
        name: b.name,
        title: b.title,
        category: b.category,
        description: clip(b.description, 120),
        ...(b.parent?.length ? {parent: b.parent} : {}),
        ...(b.ancestor?.length ? {ancestor: b.ancestor} : {}),
        ...(b.is_dynamic ? {dynamic: true} : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const namespaces = {};
    for (const b of items) namespaces[b.name.split('/')[0]] = (namespaces[b.name.split('/')[0]] || 0) + 1;
    return ctx.result({count: items.length, namespaces, block_types: items, note: 'parent: may only be placed directly inside one of those blocks; ancestor: somewhere inside one. Read a block\'s attributes with get_block_type before writing it.'});
  },

  /** One block type's attributes, supports, nesting rules, styles and variations. */
  async get_block_type(ctx, args) {
    if (!BLOCK_NAME.test(args.name)) throw new Error('name must be a block name such as core/paragraph or woocommerce/product-price.');
    let b;
    try {
      b = await ctx.request('/block-types/' + args.name);
    } catch (error) {
      if (error.status === 404) throw new Error('Block type ' + args.name + ' is not registered on site ' + ctx.site.site_id + '. Use list_block_types to see the blocks it has.');
      throw error;
    }
    const attributes = {};
    for (const [key, a] of Object.entries(b.attributes || {})) {
      if (key === 'lock' || key === 'metadata') continue;
      attributes[key] = {
        type: a.type,
        ...(a.enum ? {enum: a.enum} : {}),
        ...(a.default !== undefined ? {default: a.default} : {}),
        // Values with a source live in the block's HTML, not in the comment's JSON.
        ...(a.source ? {source: a.source, ...(a.selector ? {selector: a.selector} : {}), ...(a.attribute ? {attribute: a.attribute} : {})} : {}),
      };
    }
    return ctx.result({
      name: b.name,
      title: b.title,
      description: clip(b.description, 300),
      category: b.category,
      dynamic: !!b.is_dynamic,
      attributes,
      supports: b.supports || {},
      ...(b.parent?.length ? {parent: b.parent} : {}),
      ...(b.ancestor?.length ? {ancestor: b.ancestor} : {}),
      ...(b.allowed_blocks?.length ? {allowed_blocks: b.allowed_blocks} : {}),
      styles: (b.styles || []).map(s => s.name),
      variations: (b.variations || []).slice(0, 50).map(v => ({name: v.name, title: v.title, ...(v.attributes ? {attributes: v.attributes} : {})})),
      how_to_write: 'Serialize as <!-- wp:' + b.name.replace(/^core\//, '') + ' {"attribute":"value"} -->HTML<!-- /wp:' + b.name.replace(/^core\//, '') + ' -->' + (b.is_dynamic && !Object.values(b.attributes || {}).some(a => a && a.source) ? ' (this block renders on the server and keeps no HTML of its own, so it is written self-closing: <!-- wp:' + b.name.replace(/^core\//, '') + ' {…} /-->)' : '') + '. Attributes with a source are read from the HTML, so put their values in the markup, not in the JSON.',
    });
  },

  /** Check block markup against the registered block types before it is saved. Same rules as WP Publisher 1.9.0. */
  async check_blocks(ctx, args) {
    if (!args.content.trim()) throw new Error('content cannot be blank.');
    let tree;
    try {
      tree = parse(args.content);
    } catch (error) {
      return ctx.result({ok: false, blocks_checked: 0, problems: [error.message + ' Fix the block comments before saving.'], warnings: []});
    }
    const list = await ctx.request('/block-types?context=edit');
    const types = new Map((Array.isArray(list) ? list : []).filter(t => t && typeof t.name === 'string').map(t => [t.name, t]));
    const problems = [];
    const warnings = [];
    const unknown = new Set();
    let checked = 0;
    const all = entries(args.content, tree);
    const nameAt = new Map(all.map(e => [e.path, e.name]));
    const nonEmpty = value => (Array.isArray(value) && value.length ? value : null);
    for (const {path, name, node} of all) {
      if (name === 'html') continue;
      checked++;
      const where = 'block ' + path + ' (' + name + ')';
      const type = types.get(name);
      if (!type) {
        unknown.add(name);
        problems.push(where + ': site ' + ctx.site.site_id + ' has no such block type. The editor shows it as missing.');
        continue;
      }
      checkAttributes(type, node.attrs && typeof node.attrs === 'object' && !Array.isArray(node.attrs) ? node.attrs : {}, where, problems, warnings);
      if (node.selfClosing && !type.is_dynamic) warnings.push(where + ': a static block written as a self-closing comment has no HTML, so it shows nothing until it is edited in the editor.');
      const parentPath = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '';
      const parentName = parentPath ? nameAt.get(parentPath) : null;
      if (nonEmpty(type.parent) && !type.parent.includes(parentName)) {
        problems.push(where + ': must be placed directly inside ' + type.parent.join(' or ') + (parentName ? ', not ' + parentName : ', not at the top level') + '.');
      }
      if (nonEmpty(type.ancestor)) {
        const ancestors = [];
        for (let p = parentPath; p; p = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '') ancestors.push(nameAt.get(p));
        if (!type.ancestor.some(a => ancestors.includes(a))) problems.push(where + ': must be placed somewhere inside ' + type.ancestor.join(' or ') + '.');
      }
      const allowed = nonEmpty(type.allowed_blocks);
      if (allowed) {
        for (const child of node.children) {
          if (!allowed.includes(child.name)) problems.push(where + ': may only contain ' + allowed.join(', ') + ', not ' + child.name + '.');
        }
      }
    }
    return ctx.result({
      ok: problems.length === 0,
      blocks_checked: checked,
      problems,
      warnings,
      ...(unknown.size ? {unknown_block_types: [...unknown]} : {}),
      note: 'Checks block names, attribute types and allowed values, and nesting rules. It cannot check that a static block\'s HTML matches what the block saves; the editor reports that when the content is opened.',
    });
  },

  /** The active theme's colours, gradients, fonts, font sizes, spacing and layout widths, with the user's changes. */
  async get_brand_styles(ctx) {
    const notes = {list: [], user: 'Saved Site Editor styles could not be read; showing the theme\'s defaults', global: 'The theme\'s global styles could not be read'};
    // No _fields here: older WordPress versions drop _links from filtered responses.
    const themes = await ctx.request('/themes?status=active');
    const theme = Array.isArray(themes) ? themes[0] : null;
    if (!theme?.stylesheet) throw new Error('WordPress did not report the active theme of site ' + ctx.site.site_id + '.');
    const userHref = theme._links?.['wp:user-global-styles']?.[0]?.href;
    const userId = typeof userHref === 'string' ? (userHref.match(/global-styles(?:%2F|\/)(\d+)/) || [])[1] : undefined;
    const stylesheet = theme.stylesheet.split('/').map(encodeURIComponent).join('/');
    const styles = await optional({
      global: () => ctx.request('/global-styles/themes/' + stylesheet),
      user: () => (userId ? ctx.request('/global-styles/' + userId + '?context=edit') : Promise.resolve(null)),
    }, notes);
    const base = styles.global || {};
    const user = styles.user || {};
    const setting = (...keys) => [base.settings, user.settings].map(s => keys.reduce((o, k) => o?.[k], s));
    const supports = theme.theme_supports || {};
    const [themeColors, userColors] = setting('color', 'palette');
    const [themeGradients, userGradients] = setting('color', 'gradients');
    const [themeSizes, userSizes] = setting('typography', 'fontSizes');
    const [themeFonts, userFonts] = setting('typography', 'fontFamilies');
    const [themeSpacing, userSpacing] = setting('spacing', 'spacingSizes');
    const [themeLayout, userLayout] = setting('layout');
    const colors = mergePresets(themeColors ?? supports['editor-color-palette'], userColors);
    const gradients = mergePresets(themeGradients ?? supports['editor-gradient-presets'], userGradients);
    const fontSizes = mergePresets(themeSizes ?? supports['editor-font-sizes'], userSizes);
    const fonts = mergePresets(themeFonts, userFonts);
    const spacing = mergePresets(themeSpacing, userSpacing);
    const style = (...keys) => cssValue([user.styles, base.styles].map(s => keys.reduce((o, k) => o?.[k], s)).find(v => v !== undefined));
    const name = theme.name && typeof theme.name === 'object' ? theme.name.raw ?? theme.name.rendered : theme.name;

    return ctx.result({
      theme: {name, stylesheet: theme.stylesheet, block_theme: !!theme.is_block_theme},
      colors: colors.slice(0, 60).map(c => ({slug: c.slug, name: c.name, color: c.color, css: 'var(--wp--preset--color--' + c.slug + ')'})),
      gradients: gradients.slice(0, 30).map(g => ({slug: g.slug, name: g.name, gradient: g.gradient})),
      font_sizes: fontSizes.slice(0, 30).map(f => ({slug: f.slug, name: f.name, size: f.size})),
      font_families: fonts.slice(0, 20).map(f => ({slug: f.slug, name: f.name, font_family: f.fontFamily})),
      spacing_sizes: spacing.slice(0, 30).map(s => ({slug: s.slug, name: s.name, size: s.size})),
      layout: {content_size: (userLayout || themeLayout)?.contentSize, wide_size: (userLayout || themeLayout)?.wideSize},
      base_styles: {
        background: style('color', 'background'),
        text: style('color', 'text'),
        link: style('elements', 'link', 'color', 'text'),
        heading_font: style('elements', 'heading', 'typography', 'fontFamily'),
        body_font: style('typography', 'fontFamily'),
        body_size: style('typography', 'fontSize'),
        button_background: style('elements', 'button', 'color', 'background'),
        button_text: style('elements', 'button', 'color', 'text'),
      },
      how_to_use: 'In blocks, refer to presets by slug so content follows the theme when it changes: {"backgroundColor":"<slug>","textColor":"<slug>"}, {"gradient":"<slug>"}, {"fontSize":"<slug>"}, {"fontFamily":"<slug>"}, and spacing as "var:preset|spacing|<slug>". Use fixed values only when no preset fits.',
      ...(notes.list.length ? {notes: notes.list} : {}),
    });
  },
};
