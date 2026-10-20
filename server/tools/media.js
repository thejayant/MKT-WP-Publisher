'use strict';
// Local image folder listing and uploads. Files must sit directly in the site's configured folder.

const fs = require('node:fs/promises');
const path = require('node:path');
const {MAX_IMAGE_BYTES, IMAGE_TYPES} = require('../constants.js');

const MAX_LISTED = 500;

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
        // Same rule as upload_image: the file must resolve directly inside the folder.
        const file = await fs.realpath(path.join(root, entry.name));
        if (path.dirname(file) !== root) continue;
        const stat = await fs.stat(file);
        if (!stat.isFile()) continue;
        items.push({
          file_name: entry.name,
          type,
          size_bytes: stat.size,
          modified: stat.mtime.toISOString(),
          ...(stat.size > MAX_IMAGE_BYTES ? {uploadable: false, reason: 'over 20 MB'} : {}),
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
    if (!mime) throw new Error('Use PNG, JPG, or WebP.');
    const bytes = await fs.readFile(file);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds 20 MB.');

    const safeName = path.basename(file).replace(/[^a-zA-Z0-9._-]/g, '_');
    const media = await ctx.request('/media', {
      method: 'POST',
      body: bytes,
      headers: {'Content-Type': mime, 'Content-Disposition': 'attachment; filename="' + safeName + '"'},
    });
    try {
      await ctx.request('/media/' + media.id, {method: 'POST', body: {alt_text: args.alt_text, title: args.title || path.parse(safeName).name}});
    } catch {
      throw new Error('Image uploaded on site ' + site.site_id + ' as media ID ' + media.id + ' but metadata update failed or was cancelled. Reuse that site and ID; do not upload it again.');
    }
    return ctx.result({media_id: media.id, url: media.source_url, alt_text: args.alt_text});
  },
};
