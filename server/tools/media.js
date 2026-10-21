'use strict';
// Local image folder listing and uploads. Files must sit directly in the site's configured folder.

const fs = require('node:fs/promises');
const path = require('node:path');
const {MAX_IMAGE_BYTES, IMAGE_TYPES} = require('../constants.js');

const MAX_LISTED = 500;
const SNIFF_BYTES = 16;

/** Detect the image type from the file's first bytes, so a renamed file is caught before upload. */
function sniff(bytes) {
  const ascii = (start, end) => bytes.subarray(start, end).toString('latin1');
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return 'image/gif';
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return 'image/avif';
  return null;
}

async function readHead(file) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const {bytesRead} = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const escapeAttr = text => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function requireFolder(ctx) {
  if (!ctx.site.image_dir) throw new Error('Select a blog image folder for this website in extension settings.');
}

module.exports = {
  async list_images(ctx, args) {
    requireFolder(ctx);
    let root;
    let entries;
    try {
      root = await fs.realpath(ctx.site.image_dir);
      entries = await fs.readdir(root, {withFileTypes: true});
    } catch {
      throw new Error('Image folder is missing or inaccessible for site ' + ctx.site.site_id + '. Check this website\'s blog image folder.');
    }
    const search = (args.search || '').trim().toLowerCase();
    const items = [];
    for (const entry of entries) {
      const type = IMAGE_TYPES[path.extname(entry.name).toLowerCase()];
      if (!type || !(entry.isFile() || entry.isSymbolicLink())) continue;
      if (search && !entry.name.toLowerCase().includes(search)) continue;
      try {
        // Same rules as upload_image: the file must resolve directly inside the folder and its content must match its extension.
        const file = await fs.realpath(path.join(root, entry.name));
        if (path.dirname(file) !== root) continue;
        const stat = await fs.stat(file);
        if (!stat.isFile()) continue;
        let problem = stat.size > MAX_IMAGE_BYTES ? 'over 20 MB' : null;
        if (!problem && sniff(await readHead(file)) !== type) problem = 'content does not match the file extension';
        items.push({
          file_name: entry.name,
          type,
          size_bytes: stat.size,
          modified: stat.mtime.toISOString(),
          ...(problem ? {uploadable: false, reason: problem} : {}),
        });
      } catch {
        // Broken symlink or unreadable entry: leave it out.
      }
    }
    items.sort((x, y) => x.file_name.localeCompare(y.file_name));
    return ctx.result({image_folder: ctx.site.image_dir, items: items.slice(0, MAX_LISTED), total: items.length, truncated: items.length > MAX_LISTED});
  },

  async upload_image(ctx, args) {
    const {site} = ctx;
    if (!args.alt_text.trim()) throw new Error('alt_text cannot be blank.');
    requireFolder(ctx);
    if (!args.file_name || path.basename(args.file_name) !== args.file_name || /[\\/]/.test(args.file_name)) {
      throw new Error('Use just a file name within the selected image folder.');
    }
    if (args.post_type !== undefined && args.featured_for_post_id === undefined) throw new Error('post_type is only used with featured_for_post_id.');
    let root;
    let file;
    try {
      root = await fs.realpath(site.image_dir);
      file = await fs.realpath(path.join(root, args.file_name));
    } catch {
      throw new Error('Image file or folder is missing or inaccessible for site ' + site.site_id + '. Check this website\'s blog image folder and filename.');
    }
    if (path.dirname(file) !== root) throw new Error('Image must be inside the selected folder, without an external symlink.');
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('Image must be a file at most 20 MB.');
    const mime = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!mime) throw new Error('Use PNG, JPG, WebP, GIF, or AVIF.');
    const bytes = await fs.readFile(file);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds 20 MB.');
    const actual = sniff(bytes);
    if (actual !== mime) {
      throw new Error('The content of ' + args.file_name + ' is ' + (actual || 'not a supported image') + ', but its extension says ' + mime + '. Rename or re-export it; nothing was uploaded.');
    }

    // Check the target draft before uploading, so a wrong post ID does not leave an orphan image.
    let route = '/posts';
    if (args.featured_for_post_id !== undefined) {
      const pc = await require('./posts.js').postContext(ctx, args);
      route = pc.route;
      const target = await ctx.request(route + '/' + args.featured_for_post_id + '?context=edit');
      if (!['draft', 'pending'].includes(target.status)) throw new Error('featured_for_post_id must be a draft or pending ' + pc.kind + '; nothing was uploaded.');
    }

    const safeName = path.basename(file).replace(/[^a-zA-Z0-9._-]/g, '_');
    const media = await ctx.request('/media', {
      method: 'POST',
      body: bytes,
      upload: true,
      headers: {'Content-Type': mime, 'Content-Disposition': 'attachment; filename="' + safeName + '"'},
    });
    try {
      await ctx.request('/media/' + media.id, {method: 'POST', body: {alt_text: args.alt_text, title: args.title || path.parse(safeName).name}});
    } catch {
      throw new Error('Image uploaded on site ' + site.site_id + ' as media ID ' + media.id + ' but metadata update failed or was cancelled. Reuse that site and ID; do not upload it again.');
    }
    const out = {
      media_id: media.id,
      url: media.source_url,
      alt_text: args.alt_text,
      // Ready to paste into post content; the wp-image class lets the block editor link it to the media item.
      html: '<figure class="wp-block-image"><img src="' + escapeAttr(media.source_url ?? '') + '" alt="' + escapeAttr(args.alt_text) + '" class="wp-image-' + media.id + '" /></figure>',
    };
    if (args.featured_for_post_id !== undefined) {
      try {
        await ctx.request(route + '/' + args.featured_for_post_id, {method: 'POST', body: {featured_media: media.id}});
      } catch {
        throw new Error('Image uploaded on site ' + site.site_id + ' as media ID ' + media.id + ', but setting it as the featured image of ' + args.featured_for_post_id + ' failed or was cancelled. Use update_draft with featured_media ' + media.id + '; do not upload it again.');
      }
      out.featured_for_post_id = args.featured_for_post_id;
    }
    return ctx.result(out);
  },
};
