'use strict';
// HTTP client for the WordPress REST API: auth, timeouts, retries, cancellation, error messages,
// the plain-permalink fallback and the optional debug log.

const DEFAULT_TIMEOUTS = {request: 60000, upload: 180000};
// Busy shared hosting briefly answers 429/502/503/504. Only reads are retried; a write may already have happened.
const RETRY_STATUSES = [429, 502, 503, 504];
const SAFE_METHODS = ['GET', 'OPTIONS'];
const RETRY_DELAYS_MS = [1000, 3000];
const MAX_RETRY_AFTER_MS = 10000;

// Extra guidance for WordPress error codes that have a clear fix.
const HINTS = {
  term_exists: 'A term with that name already exists on this site. Use list_categories or list_tags to find its ID.',
  rest_cannot_edit_others: 'This website\'s connected account cannot credit posts to another author. Connect it with an Editor or Administrator account, or leave author out.',
  rest_invalid_author: 'That author ID is not a user on this website. Use list_authors for this site.',
};

function checkCancelled(signal) {
  if (signal?.aborted) throw new Error('Request cancelled. Check the selected WordPress site before retrying a write; it may already have succeeded.');
}

/** Wait, but stop early (with the cancellation error) if the caller cancels. */
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(timer);
      if (signal?.aborted) {
        try {
          checkCancelled(signal);
        } catch (error) {
          reject(error);
        }
      } else {
        resolve();
      }
    }
    signal?.addEventListener('abort', done, {once: true});
  });
}

/** The ?rest_route= form of an endpoint, for sites using plain permalinks where /wp-json is not routed. */
function plainUrl(site, endpoint, namespace = 'wp/v2') {
  const [routePath, query] = endpoint.split(/\?(.*)/s);
  return site.site_url + '/?rest_route=' + encodeURIComponent('/' + namespace + routePath).replace(/%2F/g, '/') + (query ? '&' + query : '');
}

/** Pretty-permalink URL of an endpoint in any REST namespace (wp/v2 by default, wc/v3 for WooCommerce). */
function prettyUrl(site, endpoint, namespace = 'wp/v2') {
  return namespace === 'wp/v2' ? site.base + endpoint : site.site_url + '/wp-json/' + namespace + endpoint;
}

/**
 * The low-level reason a fetch failed (DNS, connect, TLS, redirect…), from the error's cause chain.
 * fetch's own message is just "fetch failed"; the cause holds the code. Request headers, and so credentials,
 * never appear in these messages.
 */
function describeCause(error) {
  const parts = [];
  for (let e = error?.cause ?? error, depth = 0; e && depth < 4; e = e.cause, depth++) {
    const nested = Array.isArray(e.errors) ? ' [' + e.errors.map(x => [x.code, x.address].filter(Boolean).join(' ')).join(', ') + ']' : '';
    parts.push([e.code, e.message].filter(Boolean).join(' ') + nested);
  }
  return parts.join(' <- ').replace(/\s+/g, ' ').slice(0, 300) || 'unknown error';
}

function httpError(status, data) {
  const code = typeof data?.code === 'string' ? data.code.replace(/[^a-zA-Z0-9_-]/g, '') : 'error';
  // WordPress's own message, HTML stripped and capped so a verbose page cannot flood the reply.
  const message = typeof data?.message === 'string' ? data.message.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200).replace(/\.$/, '') : '';
  const error = new Error('WordPress HTTP ' + status + ' (' + code + ')' + (message ? ': ' + message : '') + '. ' + (HINTS[code] || 'Check credentials, role, and security settings.'));
  return Object.assign(error, {status, code});
}

function retryDelay(response, attempt) {
  const seconds = Number(response.headers?.get?.('Retry-After'));
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return RETRY_DELAYS_MS[attempt];
}

/**
 * Create the request function shared by all tool calls of one server process.
 * It remembers which sites need the plain-permalink URL form.
 * @param fetcher fetch implementation
 * @param options {timeouts: {request, upload}, sleep(ms, signal), log(line) or null}
 */
function createClient(fetcher, {timeouts = {}, sleep = abortableSleep, log = null} = {}) {
  const limits = {...DEFAULT_TIMEOUTS, ...timeouts};
  const plainSites = new Set();

  /**
   * Send one REST request to a site and return the parsed JSON.
   * @param site     connection from readSites
   * @param signal   caller's AbortSignal (tool-call cancellation)
   * @param endpoint path under /wp/v2, with an optional query string
   * @param options  {method, body (object or Buffer), headers, meta (receives total/total_pages), upload (longer timeout)}
   */
  async function request(site, signal, endpoint, {method = 'GET', body, headers = {}, meta, upload = false, namespace = 'wp/v2'} = {}) {
    checkCancelled(signal);
    const isJsonBody = body !== undefined && !Buffer.isBuffer(body);
    const timeoutMs = upload ? limits.upload : limits.request;

    // One HTTP attempt with its own timeout, linked to the caller's cancellation.
    const send = async url => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, {once: true});
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        abort();
      }, timeoutMs);
      const started = Date.now();
      try {
        let response;
        try {
          response = await fetcher(url, {
            method,
            redirect: 'error',
            signal: controller.signal,
            headers: {Authorization: site.auth, ...(isJsonBody ? {'Content-Type': 'application/json'} : {}), ...headers},
            body: body === undefined ? undefined : isJsonBody ? JSON.stringify(body) : body,
          });
        } catch (error) {
          checkCancelled(signal);
          const elapsed = Date.now() - started;
          const reason = timedOut ? 'timed out after ' + Math.round(timeoutMs / 1000) + ' s with no response' : 'failed after ' + elapsed + ' ms: ' + describeCause(error);
          log?.(site.site_id + ' ' + method + ' ' + endpoint.split('?')[0] + ' ' + reason);
          throw new Error('Network request ' + reason + ' [Node ' + process.version + ']. For a write, check the selected WordPress site before retrying; it may have succeeded. Check its canonical HTTPS URL.');
        }
        let data;
        let parsed = true;
        try {
          data = await response.json();
        } catch {
          parsed = false;
        }
        checkCancelled(signal);
        // Path only: query strings can hold search text, and headers/bodies can hold credentials or content.
        log?.(site.site_id + ' ' + method + ' ' + endpoint.split('?')[0] + ' ' + response.status + (parsed ? '' : ' non-JSON') + ' ' + (Date.now() - started) + 'ms');
        return {response, data, parsed};
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    };

    const sendWithRetry = async url => {
      let attempt = await send(url);
      for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
        if (!SAFE_METHODS.includes(method) || !RETRY_STATUSES.includes(attempt.response.status)) break;
        await sleep(retryDelay(attempt.response, i), signal);
        attempt = await send(url);
      }
      return attempt;
    };

    let {response, data, parsed} = await sendWithRetry(plainSites.has(site.site_url) ? plainUrl(site, endpoint, namespace) : prettyUrl(site, endpoint, namespace));
    // With plain permalinks /wp-json is not routed: WordPress answers with its HTML 404 page and processes nothing,
    // so retrying once via ?rest_route= is safe even for writes.
    if (!response.ok && !parsed && response.status === 404 && !plainSites.has(site.site_url)) {
      const retry = await sendWithRetry(plainUrl(site, endpoint, namespace));
      if (retry.parsed) {
        plainSites.add(site.site_url);
        ({response, data, parsed} = retry);
      }
    }
    if (!response.ok && !parsed) {
      throw Object.assign(new Error('WordPress HTTP ' + response.status + ' returned a non-JSON page instead of a REST API error. A firewall, CDN (such as Cloudflare), hosting security rule, or security plugin may be blocking the request. For a write, check the selected site before retrying; it may have succeeded.'), {status: response.status});
    }
    if (!parsed) {
      throw new Error('WordPress returned an unreadable response (HTTP ' + response.status + '). A firewall or security plugin may be altering REST API responses. For a write, check the selected site before retrying; it may have succeeded.');
    }
    if (!response.ok) throw httpError(response.status, data);
    if (meta) {
      for (const [key, header] of [['total', 'X-WP-Total'], ['total_pages', 'X-WP-TotalPages']]) {
        const n = Number(response.headers?.get?.(header));
        if (Number.isSafeInteger(n) && n >= 0) meta[key] = n;
      }
    }
    return data;
  }

  return {request, usesPlainPermalinks: site => plainSites.has(site.site_url)};
}

module.exports = {createClient, checkCancelled};
