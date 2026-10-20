# Architecture

## Overview

```
┌──────────────────┐  stdio (JSON-RPC 2.0, one message per line)  ┌───────────────────────────┐
│  Claude Desktop  │ ───────────────────────────────────────────▶ │ node server/index.js      │
│  (MCP client)    │ ◀─────────────────────────────────────────── │  └─ service.js start()    │
└──────────────────┘                                              └─────────────┬─────────────┘
        │ user_config → env vars (manifest.json mcp_config.env)                  │ HTTPS + Basic auth
        ▼                                                                         ▼
  Settings UI (5 website groups + advanced fields)          WordPress REST API  https://site/wp-json/wp/v2
                                                            Local disk: per-site image folder (read only)
```

One process, no network listener, no dependencies.

## Modules (`server/`)

| File | Responsibility |
| --- | --- |
| `index.js` | Entry point. Calls `start()`. |
| `service.js` | `makeService(env, fetcher, options)` builds the tool dispatcher: validate → `readSites` → find the site → build the per-call `ctx` → call the handler. `start()` wires it to `rpc.js`. Exports `makeService`, `tools`, `start`, `VERSION`. |
| `constants.js` | `VERSION`, the 5-site limit, image types and size limit, slug pattern. |
| `schema.js` | The 14 tool definitions (`inputSchema`, `outputSchema`, annotations) and `validate(schema, args)`: required keys, no unknown keys (this blocks `status`, `date` and `__proto__`), types, pattern, `enum`, `const`, integer arrays, string-only objects. |
| `config.js` | `readSites(env)` turns settings into `Map<site_id, {site_url, base, auth, image_dir, label}>`. Applies config precedence and all URL/credential checks. Runs on **every** call, so changed settings apply after an extension restart. |
| `wp-client.js` | `createClient(fetcher, {timeouts, sleep, log})` returns `request(site, signal, endpoint, {method, body, headers, meta, upload})`. Details below. |
| `rpc.js` | `serve(call)`: the JSON-RPC stdio loop, per-site queues, cancellation, `structuredContent`. |
| `markdown.js` | `markdownToHtml(md)`, see below. |
| `util.js` | `raw()` (WordPress `{raw, rendered}` fields), `decode()` (entities in term names), `paged()`, `checkText()` (blank text and slug rules). |
| `tools/sites.js` | `test_connection` (`list_sites` is answered in `service.js` with no network). |
| `tools/taxonomy.js` | `list_authors`, `list_categories`, `list_tags`, `create_term`. |
| `tools/media.js` | `list_images`, `upload_image`, and image content sniffing. |
| `tools/posts.js` | `list_posts`, `get_post`, `create_draft`, `update_draft`, `publish_post`, `schedule_post`, plus the shared helpers: post/page context, SEO Bridge check, slug and concurrency guards. |

Every handler receives `ctx = {site, signal, state, request(endpoint, options), usesPlainPermalinks(), result(data)}` and the validated `args`. `result()` wraps data as `{site_id, site_url, data}`.

### The WordPress client (`wp-client.js`)

- **Auth and safety:** Basic auth header, `redirect: 'error'`, JSON bodies serialised, `Buffer` bodies sent raw.
- **Timeouts:** 60 s per attempt, or 180 s for the media upload (`upload: true`). Each attempt is linked to the caller's abort signal.
- **Retries:** `GET` and `OPTIONS` only, on 429/502/503/504. There are at most 2 retries, after 1 s and 3 s, or after `Retry-After` (capped at 10 s). Writes are never retried, because the first attempt may already have been applied.
- **Plain permalinks:** a non-JSON 404 from `/wp-json` is retried once as `/?rest_route=/wp/v2/…`, and the site is remembered.
- **Errors:** non-JSON pages report the status plus a firewall hint. WordPress errors give `HTTP status (code): message`, with HTML stripped, at most 200 characters, and a hint for known codes. Paging headers go into `meta`.
- **Debug log (`MKT_WP_DEBUG`):** one line per attempt, `site method path status time`. The query string, headers and bodies are never logged.

## Configuration → environment

`manifest.json` maps each setting to an env var:

| Settings | Env vars |
| --- | --- |
| Website *n* group (n = 1–5) | `WP_SITE_n_ENABLED`, `_LABEL`, `_URL`, `_USERNAME`, `_APP_PASSWORD`, `_IMAGE_DIR` |
| Advanced: sites JSON | `WP_SITES_JSON` |
| Advanced: single site | `WP_SITE_URL`, `WP_USERNAME`, `WP_APP_PASSWORD` |
| Advanced: shared image folder | `WP_IMAGE_DIR` (fallback for JSON/single-site only) |
| Advanced: debug log | `MKT_WP_DEBUG` |

Resolution order (first match wins):

```
any WP_SITE_n_ENABLED=true ──yes──▶ use enabled groups only (IDs website-n)
        │no
any group field filled? ──yes──▶ ERROR "All configured website sections are disabled"
        │no
WP_SITES_JSON non-empty ──yes──▶ parse JSON array (custom IDs, max 5)
        │no
legacy single-site complete ──yes──▶ site_id "default"
        │no
ERROR "Configure WordPress sites…"
```

URLs must be HTTPS. Plain `http://` is accepted only for local development hosts: `localhost`, `127.0.0.1`, `[::1]`, `*.local`, `*.test` and `*.localhost`.

## Request lifecycle (`tools/call`)

1. A line arrives on stdin → `JSON.parse` → envelope check (`jsonrpc: '2.0'`, string `method`, string/integer `id`).
2. It's stored in `pending` with an `AbortController` and added to the queue for its `site_id`. Calls with no site go to a `global` queue.
3. When it runs: find the tool → `validate` → `readSites(env)` → look up `site_id` → handler.
4. The handler makes one or more `request()` calls. Each checks the abort signal before and after.
5. The result is `{content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value}`. A thrown error becomes `{content: [text], isError: true}` with no `structuredContent`.
6. Nothing is sent if the request was cancelled.

### Multi-step tools

| Tool | HTTP sequence |
| --- | --- |
| `create_draft` | `GET /posts?slug=…&status=draft,pending,future,publish,private` → `POST /posts {…, status: 'draft'}` |
| `update_draft` | `GET /posts/{id}?context=edit` (status check, optional `expected_modified_gmt` check) → if the slug changes, `GET /posts?slug=…` → `POST /posts/{id}` |
| `publish_post` | `GET /posts/{id}?context=edit` (title, status, date and optional modified checks) → `POST /posts/{id} {status: 'publish'}` |
| `schedule_post` | `GET /posts/{id}?context=edit` (title, time, status and optional modified checks) → `POST /posts/{id} {status: 'future', date_gmt}` |
| `upload_image` | (with `featured_for_post_id`: `GET /posts/{id}` status check) → `POST /media` (raw bytes, 180 s) → `POST /media/{id} {alt_text, title}` → (with `featured_for_post_id`: `POST /posts/{id} {featured_media}`) |
| `list_authors` | `GET /users?context=edit&capabilities=edit_posts` → on a 400/403 `rest_*` permission error only, `GET /users?who=authors` |
| `create_term` | `GET /categories|tags?search=name` (reuse an exact name/slug match) → `POST /categories|tags` |
| any write with `seo` | `OPTIONS /posts` (the bridge schema advertises the active SEO plugin; cached per site once found) → the normal sequence, with `mkt_seo` in the body |

Pages use the same sequences with `/pages` instead of `/posts`.

`list_images` makes no HTTP requests. It uses `readdir`, the same `realpath` rule as `upload_image`, and reads the first 16 bytes of each file to check that its content matches its extension.

None of these sequences is atomic. `expected_modified_gmt` narrows the window, but another editor can still change the post between the read and the write.

## Markdown (`server/markdown.js`)

`markdownToHtml(md)` is a small two-level parser:

- `blocks()` handles block structure: fences, headings, rules, quotes, tables, lists with nesting, raw HTML blocks and paragraphs.
- `inline()` handles spans. Code spans, escapes, links, images and inline HTML are swapped out for placeholders first, so emphasis rules can't reach into them.
- URLs pass through `safeUrl`, which allows only http(s), mailto, tel, relative and fragment links.
- Soft line breaks become spaces, because WordPress's `wpautop` would turn them into `<br>`.

## SEO Bridge (`wordpress-plugin/`)

A WordPress plugin that calls `register_rest_field('post'|'page', 'mkt_seo', …)`:

- **get:** `{plugin, version, title, description, focus_keyword, canonical}`, read from Yoast or Rank Math post meta. Only shown to users who can edit the post (edit context).
- **update:** `sanitize_text_field`, then `update_post_meta` (an empty string → `delete_post_meta`). Needs `edit_post`.
- **early save (1.1.0):** for existing posts, a `rest_pre_insert_{post|page}` filter saves the values before WordPress saves the post, so Yoast rebuilds its indexable from them; `update_callback` then skips. New posts are saved by `update_callback` (they have an ID only after insert).
- **schema:** `plugin.enum` is set to the active SEO plugin (`yoast`, `rank-math` or `none`), and `version.enum` to the bridge version, when the field is registered. Fields carry `maxLength` (and a URL pattern for `canonical`), so WordPress rejects bad values before anything is saved. That lets the extension find out with one `OPTIONS` request, before writing anything, whether SEO writes will work.

## Security model

| Threat | Mitigation |
| --- | --- |
| Credentials leak to the model or logs | Passwords come only from `sensitive` settings via env vars. `list_sites` strips them. Errors never echo raw config or transport messages, and the debug log never includes headers, queries or bodies (tested). |
| Wrong destination | `site_id` is required. There is no default site. Every result echoes `site_id` and `site_url`. |
| Accidental publish | Drafts only. Publishing and scheduling need a `confirm_*: true` flag, an exact title match, and the host's per-call approval prompt. |
| Overwriting someone's edits | Optional `expected_modified_gmt` on update/publish/schedule. A changed slug is checked against other posts. |
| Prompt injection via website content | Server instructions and the `get_post` / `list_posts` descriptions mark website content as untrusted. |
| Local file exfiltration | Bare filename only. `realpath` must sit directly in the configured folder. Extension allowlist plus content sniffing. 20 MB limit. |
| MITM / downgrade | HTTPS only, except local development hosts. Redirects rejected. No credentials in the URL. |
| Payload injection | Unknown arguments are rejected, which blocks `status`, `date` and prototype keys. Routing fields are stripped before the body is sent. |
| Unsafe HTML in content | Markdown drops non-web URL schemes. All other HTML is left to WordPress (`kses` filters it unless the account has `unfiltered_html`). |

Trust boundary: confirmation flags are **caller assertions**. The real human check is Claude Desktop's tool-approval prompt, which is why the team rule says never "Always allow" `publish_post` or `schedule_post`.

## Concurrency

- One queue per site: calls to the same site run one after another, while different sites run in parallel.
- `initialize`, `ping` and `tools/list` skip the queues.
- `notifications/cancelled` aborts an active call (not `initialize`) or marks a queued one to be skipped.
- Shared process state: the set of plain-permalink sites (in the client) and the cache of SEO Bridge checks (`ctx.state.seoPlugins`).
