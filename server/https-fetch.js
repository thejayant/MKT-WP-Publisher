'use strict';
// The small part of fetch() that wp-client.js uses, built on node:https with an explicit list of trusted
// certificates.
//
// Why: Claude Desktop's built-in Node replaces global fetch with its own wrapper, which verifies certificates
// against the Windows store only. A stale, expired "ISRG Root X2" cross-certificate in that store makes valid
// Let's Encrypt ECDSA chains (YE1 → Root YE → ISRG Root X2) fail with CERT_HAS_EXPIRED, because Windows' root
// store has no self-signed X2 to prefer. Trusting Node's bundled (Mozilla) roots as well, as Node itself does
// with NODE_USE_SYSTEM_CA, fixes that without removing any trust the runtime had.

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

/** Node's bundled roots plus the system's certificates, or undefined (Node's default) on older Node versions. */
function trustedCertificates() {
  if (typeof tls.getCACertificates !== 'function') return undefined;
  try {
    return [...new Set([...tls.getCACertificates('bundled'), ...tls.getCACertificates('system')])];
  } catch {
    return undefined;
  }
}

/**
 * Create a fetch-like function. Supports: method, headers, string/Buffer body, signal, redirect: 'error'.
 * Resolves to {ok, status, headers: {get(name)}, json()}; rejects like fetch, with the reason in error.cause.
 */
function createHttpsFetch({ca = trustedCertificates()} = {}) {
  const agent = new https.Agent({keepAlive: true, ...(ca ? {ca} : {})});
  return function httpsFetch(url, {method = 'GET', headers = {}, body, signal, redirect = 'follow'} = {}) {
    return new Promise((resolve, reject) => {
      const fail = cause => reject(Object.assign(new TypeError('fetch failed'), {cause}));
      if (signal?.aborted) return fail(Object.assign(new Error('This operation was aborted'), {name: 'AbortError', code: 'ABORT_ERR'}));
      const target = new URL(url);
      const transport = target.protocol === 'http:' ? http : https;
      const request = transport.request(target, {method, headers, ...(transport === https ? {agent} : {})}, response => {
        if (redirect === 'error' && response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          return fail(new Error('unexpected redirect (HTTP ' + response.statusCode + ')'));
        }
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', fail);
        response.on('end', () => {
          signal?.removeEventListener('abort', onAbort);
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            headers: {get: name => {
              const value = response.headers[String(name).toLowerCase()];
              return Array.isArray(value) ? value.join(', ') : value ?? null;
            }},
            json: async () => JSON.parse(text),
          });
        });
      });
      const onAbort = () => request.destroy(Object.assign(new Error('This operation was aborted'), {name: 'AbortError', code: 'ABORT_ERR'}));
      signal?.addEventListener('abort', onAbort, {once: true});
      request.on('error', error => {
        signal?.removeEventListener('abort', onAbort);
        fail(error);
      });
      request.end(body);
    });
  };
}

module.exports = {createHttpsFetch, trustedCertificates};
