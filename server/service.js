'use strict';
// Entry module: builds the tool dispatcher and starts the stdio server.

const {VERSION, MAX_SITES} = require('./constants.js');
const {tools, validate} = require('./schema.js');
const {readSites} = require('./config.js');
const {createClient, checkCancelled} = require('./wp-client.js');
const {createHttpsFetch} = require('./https-fetch.js');
const {serve} = require('./rpc.js');

const handlers = {
  ...require('./tools/sites.js'),
  ...require('./tools/taxonomy.js'),
  ...require('./tools/media.js'),
  ...require('./tools/posts.js'),
  ...require('./tools/products.js'),
  ...require('./tools/fields.js'),
  ...require('./tools/site.js'),
  ...require('./tools/elementor.js'),
  ...require('./tools/editor-queue.js'),
};

/**
 * Create the tool dispatcher.
 * @param env      settings as environment variables (tests pass their own)
 * @param fetcher  fetch implementation (tests pass a mock)
 * @param options  {timeouts, sleep, log}: test hooks; log replaces the stderr debug writer
 * @returns async (toolName, args, signal) => result object
 */
function makeService(env = process.env, fetcher = global.fetch, options = {}) {
  // MKT_WP_DEBUG (the "Debug log" setting) writes one line per HTTP request to stderr, which Claude Desktop keeps in its MCP log.
  const debug = [true, 'true', '1'].includes(env.MKT_WP_DEBUG);
  const log = debug ? options.log || (line => process.stderr.write('[mkt-wp-publisher] ' + line + '\n')) : null;
  const client = createClient(fetcher, {timeouts: options.timeouts, sleep: options.sleep, log});
  // State that lives as long as the server process.
  const state = {seoPlugins: new Map(), postTypes: new Map(), taxonomies: new Map(), fieldBridges: new Map()};

  return async function call(name, args = {}, signal) {
    const definition = tools.find(t => t.name === name);
    if (!definition) throw new Error('Unknown tool.');
    validate(definition.inputSchema, args);
    checkCancelled(signal);
    const sites = readSites(env);

    if (name === 'list_sites') {
      return {
        sites: [...sites.values()].map(({site_id, label, site_url, image_dir, read_only}) => ({site_id, label, site_url, ...(image_dir ? {image_folder: image_dir} : {}), ...(read_only ? {read_only: true} : {})})),
        max_sites: MAX_SITES,
      };
    }
    const site = sites.get(args.site_id);
    if (!site) throw new Error('Unknown site_id. Use list_sites to choose a configured destination.');
    // Read-only websites get the tools that only read; everything else is refused before any request is made.
    if (site.read_only && !definition.annotations.readOnlyHint) {
      throw new Error('Website ' + site.site_id + ' is set to read-only in the extension settings, so ' + name + ' is not available for it. Nothing was sent to WordPress. To make changes, turn off "Read-only" for this website in the extension settings and restart the extension.');
    }
    const ctx = {
      site,
      signal,
      state,
      readOnly: site.read_only === true,
      request: (endpoint, options) => client.request(site, signal, endpoint, options),
      usesPlainPermalinks: () => client.usesPlainPermalinks(site),
      result: data => ({site_id: site.site_id, site_url: site.site_url, data}),
    };
    return handlers[name](ctx, args);
  };
}

function start() {
  // Real requests use node:https with an explicit trust list instead of the host runtime's fetch (see https-fetch.js).
  // MKT_WP_FETCH=global keeps global fetch; the child-process tests use it to mock the network.
  const fetcher = process.env.MKT_WP_FETCH === 'global' ? global.fetch : createHttpsFetch();
  serve(makeService(process.env, fetcher));
}

module.exports = {makeService, tools, start, VERSION};
