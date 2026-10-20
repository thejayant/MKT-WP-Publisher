'use strict';
// Entry module: builds the tool dispatcher and starts the stdio server.

const {VERSION, MAX_SITES} = require('./constants.js');
const {tools, validate} = require('./schema.js');
const {readSites} = require('./config.js');
const {createClient, checkCancelled} = require('./wp-client.js');
const {serve} = require('./rpc.js');

const handlers = {
  ...require('./tools/sites.js'),
  ...require('./tools/taxonomy.js'),
  ...require('./tools/media.js'),
  ...require('./tools/posts.js'),
};

/**
 * Create the tool dispatcher.
 * @param env      settings as environment variables (tests pass their own)
 * @param fetcher  fetch implementation (tests pass a mock)
 * @returns async (toolName, args, signal) => result object
 */
function makeService(env = process.env, fetcher = global.fetch) {
  const client = createClient(fetcher);
  // State that lives as long as the server process.
  const state = {seoPlugins: new Map()};

  return async function call(name, args = {}, signal) {
    const definition = tools.find(t => t.name === name);
    if (!definition) throw new Error('Unknown tool.');
    validate(definition.inputSchema, args);
    checkCancelled(signal);
    const sites = readSites(env);

    if (name === 'list_sites') {
      return {
        sites: [...sites.values()].map(({site_id, label, site_url, image_dir}) => ({site_id, label, site_url, ...(image_dir ? {image_folder: image_dir} : {})})),
        max_sites: MAX_SITES,
      };
    }
    const site = sites.get(args.site_id);
    if (!site) throw new Error('Unknown site_id. Use list_sites to choose a configured destination.');
    const ctx = {
      site,
      signal,
      state,
      request: (endpoint, options) => client.request(site, signal, endpoint, options),
      usesPlainPermalinks: () => client.usesPlainPermalinks(site),
      result: data => ({site_id: site.site_id, site_url: site.site_url, data}),
    };
    return handlers[name](ctx, args);
  };
}

function start() {
  serve(makeService());
}

module.exports = {makeService, tools, start, VERSION};
