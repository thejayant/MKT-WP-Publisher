'use strict';

const VERSION = '1.7.0';
const MAX_SITES = 5;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};
// Lowercase letters and digits in groups joined by single hyphens. Used for site IDs and slugs.
const SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
const SLUG = new RegExp(SLUG_PATTERN);

module.exports = {VERSION, MAX_SITES, MAX_IMAGE_BYTES, IMAGE_TYPES, SLUG_PATTERN, SLUG};
