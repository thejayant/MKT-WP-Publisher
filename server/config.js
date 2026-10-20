'use strict';
// Turns the extension settings (environment variables) into a map of site_id → connection details.

const {MAX_SITES, SLUG} = require('./constants.js');

// A host may pass an unset optional setting through as its literal ${user_config.*} placeholder; treat that as empty.
const PLACEHOLDER = /^\$\{user_config\.[^}]*\}$/;
const SLOT_KEYS = ['LABEL', 'URL', 'USERNAME', 'APP_PASSWORD', 'IMAGE_DIR'];
const PROFILE_KEYS = ['id', 'label', 'site_url', 'username', 'application_password', 'image_folder'];
const tooMany = () => new Error('A maximum of 5 WordPress websites is supported.');

// Local development hosts (LocalWP, DevKinsta, Docker) may use plain http://; the traffic never leaves the machine or LAN.
function isLocalDevHost(hostname) {
  const host = hostname.toLowerCase();
  return ['localhost', '127.0.0.1', '[::1]'].includes(host) || /\.(?:local|test|localhost)$/.test(host);
}

function clearPlaceholders(env) {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, typeof value === 'string' && PLACEHOLDER.test(value.trim()) ? '' : value]));
}

/** Website 1–5 groups. Returns enabled profiles and whether any group has details filled in. */
function readSlots(env) {
  const enabledBeyondMax = Object.entries(env).some(([key, value]) => /^WP_SITE_\d+_ENABLED$/.test(key) && Number(key.split('_')[2]) > MAX_SITES && (value === true || value === 'true'));
  if (enabledBeyondMax) throw tooMany();
  const slots = [];
  let hasDetails = false;
  for (let n = 1; n <= MAX_SITES; n++) {
    const prefix = 'WP_SITE_' + n + '_';
    const flag = env[prefix + 'ENABLED'];
    if (![undefined, '', true, false, 'true', 'false'].includes(flag)) throw new Error('Website ' + n + ' enable setting must be true or false.');
    if (SLOT_KEYS.some(k => typeof env[prefix + k] === 'string' && env[prefix + k].trim())) hasDetails = true;
    if (flag !== true && flag !== 'true') continue;
    if (typeof env[prefix + 'IMAGE_DIR'] !== 'string' || !env[prefix + 'IMAGE_DIR'].trim()) throw new Error('Select the blog image folder for Website ' + n + '.');
    slots.push({
      id: 'website-' + n,
      label: env[prefix + 'LABEL']?.trim() || 'Website ' + n,
      site_url: env[prefix + 'URL'],
      username: env[prefix + 'USERNAME'],
      application_password: env[prefix + 'APP_PASSWORD'],
      image_folder: env[prefix + 'IMAGE_DIR'],
    });
  }
  return {slots, hasDetails};
}

/** Pick the configuration source by precedence: enabled groups, then JSON profiles, then the legacy single site. */
function readProfiles(env) {
  const {slots, hasDetails} = readSlots(env);
  if (slots.length) return slots;
  if (hasDetails) throw new Error('All configured website sections are disabled. Enable a website to use it; no fallback website was selected.');
  if (typeof env.WP_SITES_JSON === 'string' && env.WP_SITES_JSON.trim()) {
    let profiles;
    try {
      profiles = JSON.parse(env.WP_SITES_JSON);
    } catch {
      throw new Error('WordPress sites setting is not valid JSON. Correct it in extension settings; do not paste credentials into chat.');
    }
    if (!Array.isArray(profiles) || !profiles.length) throw new Error('WordPress sites must be a nonempty JSON array.');
    return profiles;
  }
  if (!env.WP_SITE_URL || !env.WP_USERNAME || !env.WP_APP_PASSWORD) throw new Error('Configure WordPress sites, or complete all three legacy single-site settings.');
  return [{id: 'default', label: 'Default website', site_url: env.WP_SITE_URL, username: env.WP_USERNAME, application_password: env.WP_APP_PASSWORD}];
}

/** Validate one profile and build its connection. Errors name the site but never echo URLs, usernames or passwords. */
function toSite(item, index, seen, env) {
  const which = 'Site ' + (typeof item?.id === 'string' && SLUG.test(item.id) ? item.id : 'number ' + (index + 1));
  if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !PROFILE_KEYS.includes(k))) {
    throw new Error(which + ': each site must contain id, site_url, username, application_password, and optionally label and image_folder.');
  }
  if (typeof item.id !== 'string' || !SLUG.test(item.id) || seen.has(item.id)) {
    throw new Error(which + ': site IDs must be unique lowercase names using digits and single hyphens.');
  }
  const password = typeof item.application_password === 'string' ? item.application_password.replace(/\s/g, '') : '';
  if (typeof item.site_url !== 'string' || typeof item.username !== 'string' || !item.username.trim() || item.username.includes(':') || !password) {
    throw new Error(which + ' requires a valid URL, username, and Application Password.');
  }
  if (item.label !== undefined && (typeof item.label !== 'string' || !item.label.trim())) throw new Error(which + ': label must be nonempty text.');
  if (item.image_folder !== undefined && (typeof item.image_folder !== 'string' || !item.image_folder.trim())) throw new Error(which + ': image_folder must be a nonempty folder path.');
  let url;
  try {
    url = new URL(item.site_url);
  } catch {
    throw new Error(which + ': website URL is invalid.');
  }
  const allowedProtocol = url.protocol === 'https:' || (url.protocol === 'http:' && isLocalDevHost(url.hostname));
  if (!allowedProtocol || url.username || url.password || url.search || url.hash || /\/(?:wp-admin|wp-json)(?:\/|$)/i.test(url.pathname)) {
    throw new Error(which + ': use the canonical HTTPS website URL without credentials, query, fragment, wp-admin, or wp-json. Plain http:// is allowed only for local development sites (localhost, *.local, *.test, *.localhost).');
  }
  const site_url = url.href.replace(/\/+$/, '');
  return {
    site_id: item.id,
    label: item.label || item.id,
    site_url,
    image_dir: item.image_folder || env.WP_IMAGE_DIR,
    base: site_url + '/wp-json/wp/v2',
    auth: 'Basic ' + Buffer.from(item.username + ':' + password).toString('base64'),
  };
}

/** Read every configured site. Runs on each tool call, so changed settings apply after an extension restart. */
function readSites(rawEnv) {
  const env = clearPlaceholders(rawEnv);
  const profiles = readProfiles(env);
  if (profiles.length > MAX_SITES) throw tooMany();
  const sites = new Map();
  profiles.forEach((item, index) => {
    const site = toSite(item, index, sites, env);
    sites.set(site.site_id, site);
  });
  return sites;
}

module.exports = {readSites};
