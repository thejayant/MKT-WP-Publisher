# Architecture

## Overview

```
┌──────────────────┐  stdio (JSON-RPC 2.0, one message per line)  ┌───────────────────────────┐
│  Claude Desktop  │ ───────────────────────────────────────────▶ │ node server/index.js      │
│  (MCP client)    │ ◀─────────────────────────────────────────── │  └─ service.js start()    │
└──────────────────┘                                              └─────────────┬─────────────┘
        │ user_config → env vars (manifest.json mcp_config.env)                  │ HTTPS + Basic auth
        ▼                                                                         ▼
  Settings UI (5 website groups + legacy fields)            WordPress REST API  https://site/wp-json/wp/v2
                                                            Local disk: per-site image folder (read only)
```

One process, no network listener, no dependencies. Everything lives in `server/service.js`.

## Modules inside `service.js`

| Part | Lines (approx.) | Responsibility |
| --- | --- | --- |
| Schema helpers (`str`, `int`, `ids`, `siteId`, `fields`, `tool()`) | 7–14 | Build JSON Schemas and MCP annotations. `tool()` adds `site_id` to every site-scoped tool. |
| `tools` array | 15–26 | The 14 tool definitions returned by `tools/list`. |
| `validate(schema, args)` | 27–40 | Small custom validator: required keys, no unknown keys (blocks `status`, `__proto__`), types, pattern, `enum`, `const`, integer arrays. |
| `readSites(env)` | 41–82 | Turns env vars into a `Map<site_id, {site_url, base, auth, image_dir, label}>`. Applies config precedence and all URL/credential checks. Runs on **every** call, so settings changes need only an extension restart. |
| `api()` inside `makeService` | 86–102 | `fetch` wrapper: Basic auth, `redirect: 'error'`, 60 s timeout per request, linked to the caller's abort signal, JSON parsing, WordPress error code → hint, paging headers (`X-WP-Total`, `X-WP-TotalPages`). Plain-permalink fallback: a non-JSON 404 from `/wp-json` is retried once as `/?rest_route=/wp/v2/…`, and the site is remembered in a per-process `plain` set. |
| Tool handlers (`call`) | 104–165 | One `if (name === …)` branch per tool. |
| `start()` | 167–195 | JSON-RPC stdio loop: request validation, duplicate-ID guard, cancellation, serial queue for tool calls, immediate answers for `initialize` / `ping` / `tools/list`. |

`makeService(env, fetcher)` uses dependency injection: tests pass a fake `env` and a mock `fetch`.

## Configuration → environment

`manifest.json` maps each setting to an env var:

| Settings | Env vars |
| --- | --- |
| Website *n* group (n = 1–5) | `WP_SITE_n_ENABLED`, `_LABEL`, `_URL`, `_USERNAME`, `_APP_PASSWORD`, `_IMAGE_DIR` |
| Advanced: sites JSON | `WP_SITES_JSON` |
| Advanced: single site | `WP_SITE_URL`, `WP_USERNAME`, `WP_APP_PASSWORD` |
| Advanced: shared image folder | `WP_IMAGE_DIR` (fallback for JSON/single-site only) |

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

## Request lifecycle (`tools/call`)

1. A line arrives on stdin → `JSON.parse` → envelope check (`jsonrpc: '2.0'`, string `method`, string/integer `id`).
2. Stored in `pending` with an `AbortController`; added to the serial `queue`.
3. When it runs: find the tool → `validate` → `readSites(env)` → look up `site_id`.
4. The handler makes one or more `api()` calls. Each checks the abort signal before and after.
5. The result is wrapped as `{content: [{type: 'text', text: JSON.stringify(result)}]}`. Thrown errors become `{isError: true}` with the message.
6. Nothing is sent if the request was cancelled.

### Multi-step tools

| Tool | HTTP sequence |
| --- | --- |
| `create_draft` | `GET /posts?slug=…&status=draft,pending,future,publish,private` → `POST /posts {…, status: 'draft'}` |
| `update_draft` | `GET /posts/{id}?context=edit` (check status) → `POST /posts/{id}` |
| `publish_post` | `GET /posts/{id}?context=edit` (title, status, date checks) → `POST /posts/{id} {status: 'publish'}` |
| `upload_image` | `POST /media` (raw bytes) → `POST /media/{id} {alt_text, title}` |
| `list_authors` | `GET /users?context=edit&capabilities=edit_posts` → on a 400/403 `rest_*` permission error only, `GET /users?who=authors` |
| `create_term` | `GET /categories|tags?search=name` (reuse an exact name/slug match) → `POST /categories|tags` |

| `schedule_post` | `GET /posts/{id}?context=edit` (title, time, status checks) → `POST /posts/{id} {status: 'future', date_gmt}` |
| any write with `seo` | `OPTIONS /posts` (bridge schema advertises the active SEO plugin; cached per site once found) → the normal sequence, with `mkt_seo` in the body |

Pages use the same sequences with `/pages` instead of `/posts`.

`list_images` makes no HTTP requests. It uses `readdir` plus the same `realpath` rule as `upload_image`.

## Markdown (`server/markdown.js`)

`markdownToHtml(md)` is a small two-level parser. `blocks()` handles block structure (fences, headings, rules, quotes, tables, lists with nesting, raw HTML blocks, paragraphs). `inline()` handles spans. Code spans, escapes, links, images and inline HTML are swapped out for placeholders first, so emphasis rules can't reach into them. URLs pass through `safeUrl`, which allows http(s), mailto, tel, relative and fragment links only. Soft line breaks become spaces because WordPress's `wpautop` would turn them into `<br>`.

## SEO Bridge (`wordpress-plugin/`)

A WordPress plugin that calls `register_rest_field('post'|'page', 'mkt_seo', …)`:

- **get:** `{plugin, title, description, focus_keyword}`, read from Yoast or Rank Math post meta. Only shown to users who can edit the post (edit context).
- **update:** `sanitize_text_field`, then `update_post_meta` (empty string → `delete_post_meta`). Needs `edit_post`.
- **schema:** `plugin.enum` is set to the active SEO plugin (`yoast`, `rank-math` or `none`) when it is registered, so the extension can find out from one `OPTIONS` request, before writing anything, whether SEO writes will work.

None of these sequences is atomic. Another editor can change the post between the read and the write.

## Security model

| Threat | Mitigation |
| --- | --- |
| Credentials leak to the model | Passwords come only from `sensitive` settings via env vars. `list_sites` strips them. Errors never echo raw config or transport messages (tested). |
| Wrong destination | `site_id` is required. There is no default site. Every result echoes `site_id` and `site_url`. |
| Accidental publish | Drafts only. Publishing needs `confirm_publish: true`, an exact title match, and the host's per-call approval prompt. |
| Prompt injection via website content | Server instructions and the `get_post` description mark website content as untrusted. |
| Local file exfiltration | Bare filename only. `realpath` must sit directly in the configured folder. Extension allowlist. 20 MB limit. |
| MITM / downgrade | HTTPS only. Redirects rejected. No credentials in URL. |
| Payload injection | Unknown arguments rejected, which blocks `status`, `date` and prototype keys. Routing fields are stripped before the body is sent. |
| Unsafe HTML in content | Left to WordPress (`kses` filters HTML unless the account has `unfiltered_html`). |

Trust boundary: confirmation flags are **caller assertions**. The real human check is Claude Desktop's tool-approval prompt, which is why the team rule says never "Always allow" `publish_post`.

## Concurrency

- One global queue: tool calls for **all** sites run one after another.
- `initialize`, `ping` and `tools/list` skip the queue.
- `notifications/cancelled` aborts an active call (not `initialize`) or marks a queued one to be skipped.
