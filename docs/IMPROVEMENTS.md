# Gap Analysis & Improvement Backlog

_Review date: 2026-10-20 · codebase v1.1.0 (B1–B8 fixed in v1.1.1; F1, F2, F4, F5, F9, F11 done in v1.2.0; F3, F6, F7, F12 done in v1.3.0)_

The core is solid. It has strong safety rails (no implicit site, draft-first publishing, title-confirmed publish, sandboxed image folder, no credential leaks) and good mocked test coverage. The gaps fall into three groups: small bugs, missing workflow features, and project hygiene.

Items marked **✔ reproduced** were confirmed by running the code with mocked WordPress responses.

---

## 1. Bugs & rough edges (small fixes)

| # | Issue | Impact | Fix |
| --- | --- | --- | --- |
| B1 | **Non-JSON error pages hide the HTTP status.** A Cloudflare/WAF/security-plugin HTML 403 comes back as "unreadable response… may have succeeded", even for reads. ✔ reproduced | Misleading. Hard to tell a blocked request from a timeout. | Check `r.ok` before parsing JSON. When parsing fails, include `HTTP <status>` and a hint about firewalls or security plugins. |
| B2 | **WordPress's own error `message` is dropped.** Only the `code` is shown, followed by a generic "check credentials, role…". ✔ reproduced | Users lose the most helpful text (e.g. "Sorry, you are not allowed to create posts as this user"). | Append a sanitised, length-capped `data.message` (strip HTML, ≤ 200 chars). |
| B3 | **Config errors don't say which website is wrong.** An incomplete Website 3 gives "Each site requires a valid URL, username, and Application Password." ✔ reproduced | Painful to debug with 5 groups. | Add the site ID or number to every `readSites` error (never the values). |
| B4 | **`update_draft` with no fields still writes** (`POST {}`). ✔ reproduced | Wasted write; changes the modified date. | Require at least one field. |
| B5 | **Blank `alt_text` is accepted.** ✔ reproduced | Images go up without alt text (accessibility/SEO). | Add `alt_text` to the not-blank check. |
| B6 | **Stale wording in the manifest:** the `sites_json` setting says "migration setting for v1.1.x users". That refers to *Cibirix* 1.1.x, not MKT. | Confusing for MKT users. | Change it to "for users of earlier JSON setups". |
| B7 | **`list_authors` falls back on *any* error**, including 401s and timeouts, so a bad password triggers two requests and a timeout can take up to 2 × 60 s. | Slower failures; the real error is hidden. | Fall back only on 400/403 `rest_*` permission codes. |
| B8 | **Tool annotations are coarse:** `create_draft`, `update_draft` and `upload_image` are marked `destructiveHint: true`, and `update_draft` is marked non-idempotent. | Hosts may show stronger warnings than needed and blur the difference from `publish_post`. | Mark only `publish_post` as destructive. Mark `update_draft` idempotent. |
| B9 | **The `slug` duplicate check runs only on create.** `update_draft` with a new slug lets WordPress silently add `-2`. | The URL differs from what was asked for. | Run the same check on update, or warn when the returned slug differs. |
| B10 | **The 60 s per-request timeout is fixed.** A 20 MB upload on a slow connection can time out after WordPress has already stored the file. | Orphan media and confusing retries. | Allow a longer timeout for `/media` (e.g. 180 s), or make it configurable. |

## 2. Missing features (high value for a publishing workflow)

Ordered by value to the MKT team.

| # | Feature | Why |
| --- | --- | --- |
| F1 | ✅ v1.2.0 — **`list_images`** for the site's image folder (name, size, type) | Claude can't see which images exist today, so the user has to type exact filenames. This is the most common friction point. |
| F2 | ✅ v1.2.0 — **`list_posts` / `find_post`** (search by title, slug or status; drafts only by default) | You need a post ID to do anything, and there's no way to find "the draft I made yesterday". |
| F3 | ✅ v1.3.0 (via the SEO Bridge plugin) — **SEO fields (Yoast / Rank Math):** meta title, meta description, focus keyword | This is a marketing team's tool; SEO metadata is part of every post. Needs the plugin's REST-exposed meta or a small companion plugin. |
| F4 | ✅ v1.2.0 — **Create category/tag** (`create_term`, with a duplicate check) | Today a new tag means a trip to WP admin, which breaks the flow. |
| F5 | ✅ v1.2.0 — **Lean responses** | `get_post` returns the full post object (raw + rendered content, `_links`, …). `list_categories`/`list_tags` return full term objects. This wastes tokens. Return the selected fields by default and add `full: true` for the rest. |
| F6 | ✅ v1.3.0 — **Scheduling** (`schedule_post` with an explicit future date and the same confirmation rules) | Content calendars. Today, future-dated posts are refused. |
| F7 | ✅ v1.3.0 (pages; custom post types still open) — **Pages and custom post types** (`post_type` parameter limited to an allowlist) | Landing pages and case studies. |
| F8 | **Upload by URL or with an inline image helper** | Put an uploaded image into the content (`<figure><img …>`) or set it as featured in a single step. |
| F9 | ✅ v1.2.0 — **Plain-permalink support** (fall back to `?rest_route=/wp/v2/…` on 404 `/wp-json`) | Sites without pretty permalinks can't connect at all right now. |
| F10 | **Local dev sites** (allow `http://` only for `localhost`, `*.local`, `*.test`) | Testing against LocalWP/DevKinsta without HTTPS. |
| F11 | ✅ v1.2.0 — **Preview link** in the draft summary (`?p=ID&preview=true`) | Faster human review before approving. |
| F12 | ✅ v1.3.0 (Markdown → HTML; native block markup still open) — **Markdown → HTML / Gutenberg blocks** (optional `content_format`) | Claude writes Markdown naturally. Block markup makes posts editable in the block editor. |
| F13 | **Revisions / concurrency guard** (send the `modified_gmt` read earlier; refuse if it changed) | Reduces the read-then-write race noted in the README. |
| F14 | **Image checks:** verify magic bytes against the extension; optional resize/compress; GIF/AVIF | Catches wrongly named files and large uploads. |
| F15 | **Per-site queue** instead of one global queue | A slow upload on one site won't block work on another. |
| F16 | **`outputSchema` + `structuredContent`** (MCP 2025-06-18) | Clients get typed results instead of parsing JSON text. |
| F17 | **Retry for safe reads** (GET on 429/502/503/504 with backoff) | Busy shared hosting often returns these briefly. |
| F18 | **More than 5 sites** | Only if needed. It's a manifest limit (static settings groups), so JSON profiles would be the way to do it. |

## 3. Project hygiene

| # | Item | Why |
| --- | --- | --- |
| H1 | **Put it under git** (`git init`, `.gitignore` for `*.mcpb`, `node_modules`, local `sites.json`) | No history or rollback today, and no diffs to review. |
| H2 | **Add a `pack` script and `.mcpbignore`** (exclude `test/`, `docs/`, `sites.example.json`) | Builds you can repeat, and smaller bundles. |
| H3 | **CI** (GitHub Actions: `npm test` on Node 18/20/22, Windows + Linux + macOS) | The README says macOS/Linux are unverified. CI would cover that. |
| H4 | **Readability refactor of `service.js`** — split into `config.js`, `wp-client.js`, `tools/*.js`, `rpc.js`; one statement per line; JSDoc | The current minified style is hard to review and maintain. Do it as a separate change with the tests unchanged as a safety net. |
| H5 | **Split the test file** by area and give it the same formatting cleanup | Easier to find what failed. |
| H6 | **Live integration test** (opt-in, `WP_TEST_*` env, staging site, creates and then trashes a draft) | Nothing has been checked against a real WordPress yet. |
| H7 | **Lint/format** (ESLint + Prettier, or `node --check` at minimum) | Consistency once the code is expanded. |
| H8 | **Add `LICENSE` and `repository` fields** in `package.json`/`manifest.json` | Needed if the extension is shared outside the team. |
| H9 | **Optional debug log to stderr** (`WP_DEBUG=1`: method, path, status, timing — never headers or bodies) | Troubleshooting in Claude Desktop's developer logs. |

---

## Suggested roadmap

**v1.1.1 — fixes (low risk):** B1–B8, H1, H2.
**v1.2.0 — workflow (done):** F1 `list_images`, F2 `list_posts`, F4 create terms, F5 lean responses, F11 preview link, F9 plain permalinks.
**v1.3.0 — marketing (done):** F3 SEO fields, F6 scheduling, F7 pages, F12 Markdown/blocks.
**Ongoing:** H3 CI, H4/H5 refactor, H6 live test.
