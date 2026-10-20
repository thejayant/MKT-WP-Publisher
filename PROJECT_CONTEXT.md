# Project Context — MKT WP Publisher

This file gives a developer (or an AI assistant) what they need to work on this codebase. For end-user setup, see [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

_Last reviewed: 2026-10-20 · version 1.3.0_

## What it is

MKT WP Publisher is a **Claude Desktop extension (MCPB bundle)** that runs a local **MCP server over stdio**. It lets Claude publish blog content to **up to 5 WordPress websites** through the WordPress REST API (`/wp-json/wp/v2`), using **Application Passwords** (HTTP Basic auth over HTTPS).

The flow it supports is **draft first, publish on explicit approval**:

```
list_sites → test_connection → list_authors / list_categories / list_tags
  → upload_image (from the site's local image folder) → create_draft
  → update_draft (featured image, author, taxonomy) → [human review in WP]
  → get_post → publish_post (confirm_title + confirm_publish)
```

- **Owner / author:** Jayant (MKT team)
- **Lineage:** forked from *Cibirix WP Publisher 1.2.2* (extension ID `local-wordpress-publisher`). MKT 1.0.0 had the same behaviour under a new ID (`mkt-wp-publisher`) so both can be installed together. MKT 1.1.0 added multi-author support (`list_authors`, `author` field); 1.1.1 fixed error reporting and edge cases; 1.2.0 added `list_images`, `list_posts`, `create_term`, compact responses, preview links and plain-permalink support; 1.3.0 added SEO fields (with a companion WordPress plugin), `schedule_post`, pages and Markdown content.
- **Runtime:** Node.js ≥ 18, **no npm dependencies** (uses built-in `fetch`, `readline`, `fs`).
- **Not a git repository yet.**

## File map

| Path | Purpose |
| --- | --- |
| `manifest.json` | MCPB manifest (v0.3): settings UI (`user_config`), env-var wiring, tool list, icons, compatibility. |
| `server/index.js` | Entry point; just calls `start()`. |
| `server/service.js` | **Main logic (~270 lines):** tool schemas, argument validation, config parsing, WordPress HTTP client, tool handlers, JSON-RPC stdio loop. |
| `server/markdown.js` | Dependency-free Markdown → HTML converter for `content_format: markdown` (written in readable style). |
| `wordpress-plugin/mkt-wp-publisher-seo-bridge/` | Companion WordPress plugin (PHP) that exposes Yoast/Rank Math SEO fields as the REST field `mkt_seo`. Installed on each site, not part of the `.mcpb`. |
| `test/multi-site.test.js` | `node:test` suite (54 tests) with a mocked `fetch`; also spawns the server as a child process to test the JSON-RPC layer. |
| `sites.example.json` | Example for the advanced/legacy `sites_json` setting. |
| `assets/` | Icon (SVG source + 32/128/512 PNGs). |
| `README.md` | Overview and quick start. |
| `CHANGELOG.md` | Release history, including the Cibirix history. |
| `docs/` | User guide, architecture, tool reference, development, improvement backlog. |

## Key concepts

- **Site ID** — every tool except `list_sites` requires `site_id`. Website groups get fixed IDs `website-1` … `website-5`; legacy JSON profiles keep their custom IDs; legacy single-site is `default`. **No implicit default site is ever chosen.**
- **Site-scoped IDs** — post, media, category, tag and author IDs only mean something on their own site. Every response is wrapped as `{site_id, site_url, data}` to keep them paired.
- **Config precedence** (`readSites` in `service.js`):
  1. Enabled Website 1–5 groups (each must have its own image folder).
  2. If groups have details but none is enabled → hard error (no silent fallback).
  3. `WP_SITES_JSON` (legacy multi-site, max 5).
  4. Legacy single site (`WP_SITE_URL` / `WP_USERNAME` / `WP_APP_PASSWORD`) → `default`.
- **Unset placeholders** — hosts may pass unset settings as the literal text `${user_config.x}`; these are treated as empty.
- **Image folder sandbox** — `upload_image` takes a bare filename, resolves it with `realpath`, and requires it to sit directly in that site's folder (no subfolders, traversal or external symlinks). PNG/JPEG/WebP, ≤ 20 MB.

## Invariants — do not break these

1. Credentials never appear in tool output or error messages (tested).
2. `create_draft` always forces `status: 'draft'`; `status` is not an accepted argument.
3. `publish_post` and `schedule_post` require `confirm_publish: true` **and** `confirm_title` equal to the post's current title (whitespace-normalised). `publish_post` refuses future-dated posts and anything not `draft`/`pending`; `schedule_post` needs `confirm_schedule: true` and an explicit-timezone time 2 minutes to 2 years ahead.
4. `update_draft` only touches `draft`/`pending` posts and pages.
11. A write with `seo` checks the SEO Bridge and an active SEO plugin (OPTIONS) **before** writing anything.
12. Only `publish_post` and `schedule_post` carry `destructiveHint` (tested).
5. Only HTTPS site URLs; no credentials, query, fragment, `/wp-admin` or `/wp-json` in the URL; HTTP redirects are treated as errors.
6. Tool calls are run one at a time; `initialize`, `ping` and `tools/list` are answered immediately.
7. Cancelled queued calls never run; a cancelled active call stops before its next HTTP step.
8. Uncertain write outcomes (timeout, unreadable response) produce "check WordPress before retrying" errors.
9. `list_authors` never returns email addresses.
10. Manifest `version` must equal `VERSION` in `service.js` (tested).

## Conventions

- Code style in `service.js` and the tests is **very compact** (one-line functions, short names). Keep new code in the same file and the same style unless you are doing a deliberate refactor (see [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md)).
- Errors are plain `Error`s with user-facing, actionable messages. They are returned to the client as `isError: true` tool results, not JSON-RPC errors.
- When you add a tool: add it to `tools` in `service.js`, to `manifest.json` → `tools`, to the README / tool reference, and update the `tools.length` assertion (currently 14) in the tests.
- When you bump the version: `service.js` `VERSION`, `manifest.json`, `package.json`, `README.md`, `CHANGELOG.md`.

## Commands

```bash
npm test
```

```bash
npx @anthropic-ai/mcpb pack . ../mkt-wp-publisher-1.3.0.mcpb
```

(The pack command is the standard MCPB CLI; how earlier bundles were built is not recorded in this folder.)

## Known limits (by design, today)

No custom post types, unscheduling, deletion, SEO fields beyond title/description/focus keyword, or local-HTTP sites. Markdown output is HTML (a Classic block), not native block markup. Full gap analysis and roadmap: [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md).

## Verification status

- Mocked test suite passes on Node v22.22.0 and v25.1.0 (Windows); symlink test skips on Windows without symlink rights.
- The SEO Bridge PHP plugin has **not been run or linted** (no PHP available during development).
- **Not verified:** a live WordPress site, Claude Desktop settings rendering, macOS/Linux.
