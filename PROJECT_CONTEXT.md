# Project Context — MKT WP Publisher

This file gives a developer (or an AI assistant) what they need to work on this codebase. For end-user setup, see [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

_Last reviewed: 2026-10-29 · version 1.9.0 (SEO Bridge 1.5.0)_

## What it is

MKT WP Publisher is a **Claude Desktop extension (MCPB bundle)** that runs a local **MCP server over stdio**. It lets Claude publish blog content to **up to 5 WordPress websites** through the WordPress REST API (`/wp-json/wp/v2`), using **Application Passwords** (HTTP Basic auth over HTTPS).

The flow it supports is **draft first, publish or schedule on explicit approval**:

```
list_sites → test_connection → list_authors / list_categories / list_tags / create_term
  → list_images → upload_image (optionally as featured image) → create_draft (HTML or Markdown, SEO)
  → update_draft → [human review via preview_url]
  → get_post → publish_post or schedule_post (confirm_title + confirm flag)
```

- **Owner / author:** Jayant (MKT team)
- **Lineage:** forked from *Cibirix WP Publisher 1.2.2* (extension ID `local-wordpress-publisher`). MKT 1.0.0 had the same behaviour under a new ID (`mkt-wp-publisher`) so both can be installed together. Later releases:
  - 1.1.0: authors.
  - 1.1.1: error reporting.
  - 1.2.0: `list_images`, `list_posts`, `create_term`, compact responses, preview links, plain permalinks.
  - 1.3.0: SEO fields via a companion WordPress plugin, `schedule_post`, pages, Markdown.
  - 1.4.0: image checks and featured images, concurrency guard, retries, per-site queues, `structuredContent`, debug log, local http, and the module refactor and tooling.
- **Runtime:** Node.js ≥ 18, **no npm dependencies** (uses built-in `fetch`, `readline`, `fs`).
- **Git:** local repository on branch `main`, with no remote yet.

## File map

| Path | Purpose |
| --- | --- |
| `manifest.json` | MCPB manifest (v0.3): settings UI (`user_config`), env-var wiring, tool list, icons, compatibility. |
| `server/` | The MCP server. `service.js` is the entry module (`makeService`, `start`); `schema.js` defines tools and validation; `config.js` reads settings; `wp-client.js` is the HTTP client; `rpc.js` is the stdio loop; `tools/*.js` hold the handlers; `markdown.js` converts Markdown. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). |
| `wordpress-plugin/mkt-wp-publisher-seo-bridge/` | Companion WordPress plugin "MKT Publisher SEO Bridge for Yoast & Rank Math" (PHP, v1.1.0, with `assets/` icons and `readme.txt`). Exposes Yoast/Rank Math SEO fields as the REST field `mkt_seo`, plus a Tools status page. Installed on each site, not part of the `.mcpb`. |
| `test/*.test.js` | `node:test` suites by area (164 tests) with a mocked `fetch`; `rpc.test.js` also spawns the server. `test/helpers.js` has the fixtures. |
| `test/live/wordpress.live.js` | Opt-in test against a real staging site (`npm run test:live`). |
| `scripts/` | `test.js` (test runner), `lint.js`, `pack.js` (release build), `zip.js` (dependency-free zip writer). |
| `.github/workflows/ci.yml` | CI: Node 18/20/22 × Linux/Windows/macOS, plus PHP lint. |
| `sites.example.json` | Example for the advanced/legacy `sites_json` setting. |
| `assets/` | Icon (SVG source + 32/128/512 PNGs). |
| `README.md`, `CHANGELOG.md`, `docs/` | Overview, history, user guide, architecture, tool reference, development, backlog. |

## Key concepts

- **Site ID** — every tool except `list_sites` requires `site_id`. Website groups get fixed IDs `website-1` … `website-5`; legacy JSON profiles keep their custom IDs; legacy single-site is `default`. **No implicit default site is ever chosen.**
- **Site-scoped IDs** — post, media, category, tag and author IDs only mean something on their own site (and post IDs on their own `post_type`). Every response is wrapped as `{site_id, site_url, data}` to keep them paired.
- **Config precedence** (`server/config.js`):
  1. Enabled Website 1–5 groups (each must have its own image folder).
  2. If groups have details but none is enabled → hard error (no silent fallback).
  3. `WP_SITES_JSON` (legacy multi-site, max 5).
  4. Legacy single site (`WP_SITE_URL` / `WP_USERNAME` / `WP_APP_PASSWORD`) → `default`.
- **Unset placeholders** — hosts may pass unset settings as the literal text `${user_config.x}`; these are treated as empty.
- **Image folder sandbox** — `upload_image` takes a bare filename, resolves it with `realpath`, and requires it to sit directly in that site's folder (no subfolders, traversal or external symlinks). PNG/JPEG/WebP/GIF/AVIF, content must match the extension, ≤ 20 MB.

## Invariants — do not break these

1. Credentials never appear in tool output, error messages or the debug log (tested).
2. `create_draft` always forces `status: 'draft'`; `status` is not an accepted argument.
3. `publish_post` needs `confirm_publish: true`, and `schedule_post` needs `confirm_schedule: true`. Both need `confirm_title` equal to the current title (whitespace-normalised). `publish_post` refuses future-dated posts and anything not `draft`/`pending`. `schedule_post` needs an explicit-timezone time 2 minutes to 2 years ahead.
4. `update_draft` only touches `draft`/`pending`/`future` posts and pages; live (`publish`/`private`) content changes only through `edit_published_post` or `unpublish_post`, which, like `publish_post`, need `confirm_title` plus their own `confirm_*: true` flag.
5. Site URLs are HTTPS, or `http://` only for local development hosts. No credentials, query, fragment, `/wp-admin` or `/wp-json` in the URL. HTTP redirects are treated as errors.
6. Calls to the same site run one at a time; `initialize`, `ping` and `tools/list` are answered immediately.
7. Cancelled queued calls never run; a cancelled active call stops before its next HTTP step.
8. Only reads (GET/OPTIONS) are ever retried. Uncertain write outcomes (timeout, unreadable response) produce "check WordPress before retrying" errors.
9. `list_authors` never returns email addresses.
10. Manifest, package.json and `VERSION` agree, and the manifest tool list matches the server's (`npm run lint`, also tested).
11. A write with `seo` checks the SEO Bridge and an active SEO plugin (OPTIONS) **before** writing anything.
12. Only tools that change public content carry `destructiveHint`: `publish_post`, `schedule_post`, `edit_published_post`, `unpublish_post` (tested).
13. Multi-step writes check everything they can **before** the first write (e.g. the featured-image target before uploading).
14. On a `read_only` website, every tool without `readOnlyHint` is refused in `service.js` before any request (tested for every writing tool). New tools must set `readOnly` correctly.
15. Elementor layouts are only written through the bridge, which saves through Elementor's `Document::save()`; never write `_elementor_data` directly. A page not built with Elementor is converted only with `convert: true`; pages of other builders and pages open in someone else's editor are refused.
16. `server/` (all but `index.js`, `service.js`, `rpc.js`, `https-fetch.js`) is byte-identical to `core/` in WP Publisher for ChatGPT (`D:\Jayant\AI_Jayant\WP Publisher for ChatGPT`). Every feature goes into both repositories; copy the changed files across and check with `cmp`.
17. `queue_editor_changes` and `cancel_editor_change` never write the post itself, only the bridge's editor queue. The editor script applies a change only to an editor with no unsaved edits and the same `modified_gmt` the change was prepared from.

## Conventions

- Readable style: one statement per line, 2-space indent, single quotes, `'use strict'`, short JSDoc on exported functions. `npm run lint` rejects tabs and trailing whitespace. Some older test bodies are still compact; new tests use the readable style.
- Errors are plain `Error`s with user-facing, actionable messages. They are returned to the client as `isError: true` tool results, not JSON-RPC errors. Name the site, and never echo secrets.
- When you add a tool, follow [docs/DEVELOPMENT.md#adding-a-tool](docs/DEVELOPMENT.md#adding-a-tool). The `tools.length` assertion is currently 38.
- When you bump the version: `server/constants.js`, `manifest.json`, `package.json`, the README / User Guide headings, `CHANGELOG.md`.
- Commit messages: a short summary line, a body, and the co-author trailer used in the history.

## Commands

```bash
npm test
```

```bash
npm run lint
```

```bash
npm run pack
```

## Known limits (by design, today)

No custom post types, deletion, upload from URL, image resizing, SEO fields beyond title/description/focus keyword, or more than 5 sites. Markdown output is HTML (a Classic block), not native block markup. See [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md).

## Verification status

- Mocked test suite and lint pass on Node v25.1.0 (Windows); earlier versions passed on v22.22.0. The symlink test skips on Windows without symlink rights.
- The SEO Bridge PHP plugin has **not been run or linted** locally (no PHP); CI lints it once the repo is on GitHub.
- **Not verified:** a live WordPress site (`npm run test:live` is ready for it), Claude Desktop settings rendering, macOS/Linux (covered by CI once pushed).
