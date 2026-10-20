# Changelog

## MKT WP Publisher 1.5.0

Editing beyond drafts, back-dating and unpublishing.

- New edit_published_post: change a published (or private) post or page: content, title, featured image, categories, tags, author, SEO title/description/focus keyword, slug, or its date (publish_date, past only). Like publish_post, it needs the post's current title (confirm_title) and confirm_edit:true, and is marked destructive so Claude Desktop asks for approval.
- New unpublish_post: move a published, private, scheduled or pending post or page back to draft. This also unschedules a scheduled post. Needs confirm_title and confirm_unpublish:true.
- update_draft now also edits scheduled (future) posts. They keep their publish time; a warning is shown if WordPress changes the status.
- publish_post accepts an optional publish_date (now or in the past) to back-date a post. It also publishes now a draft that carries a future date.
- Fix (from 1.4.0 testing): sites on Let's Encrypt's ECDSA chain (YE1 → Root YE → ISRG Root X2) failed with CERT_HAS_EXPIRED inside Claude Desktop when Windows has an expired ISRG Root X2 cross-certificate. Requests now use node:https and trust Node's bundled roots plus the Windows store. Network errors show the real cause (e.g. CERT_HAS_EXPIRED, ENOTFOUND) and the Node version.
- Tools: 16 (was 14).

Tool-call migration: update_draft on a published post still fails, now pointing to edit_published_post.

## MKT WP Publisher 1.4.0

The rest of the docs/IMPROVEMENTS.md backlog (B9, B10, F8, F10, F13–F17, H1–H7, H9).

Behaviour:
- upload_image returns a ready-to-paste `html` figure. With `featured_for_post_id` (and `post_type` for pages) it also sets the image as that draft's featured image; the draft is checked before anything is uploaded.
- Image content is checked against the file extension before upload, and list_images flags mismatches. GIF and AVIF are now supported (AVIF needs WordPress 6.5+).
- update_draft checks a changed slug against other posts, and warns if WordPress saves a different slug.
- update_draft, publish_post and schedule_post accept `expected_modified_gmt`: if the post changed in WordPress since it was read, nothing is written.
- Reads (GET/OPTIONS) are retried up to twice on 429/502/503/504, honouring Retry-After up to 10 s. Writes are never retried.
- Uploads get a 180 s timeout; other requests keep 60 s.
- Requests are queued per site: calls to one site stay in order, while a slow upload no longer blocks other sites.
- Plain `http://` URLs are accepted for local development sites only (localhost, 127.0.0.1, *.local, *.test, *.localhost).
- Every tool declares an `outputSchema`, and successful results include `structuredContent` (MCP 2025-06-18) next to the text copy.
- New setting, Advanced | Debug log: one line per WordPress request (site, method, path, status, time) in the extension log. Never includes passwords, query text or content.

Project:
- The server is split into readable modules (server/config.js, schema.js, wp-client.js, rpc.js, tools/*.js); the tests are split by area.
- Git repository with .gitignore/.gitattributes; GitHub Actions CI (Node 18/20/22 on Linux, Windows, macOS; PHP lint).
- npm run lint, npm run pack (builds the .mcpb and the SEO Bridge zip), npm run test:live (opt-in staging test).

Tool-call migration: none. New arguments are optional. Image files whose content doesn't match their extension are now refused.

## MKT WP Publisher 1.3.0

Marketing features from docs/IMPROVEMENTS.md (F3, F6, F7, F12).

- SEO fields: create_draft and update_draft accept seo {title, description, focus_keyword} for Yoast SEO or Rank Math. This needs the new companion WordPress plugin, MKT WP Publisher SEO Bridge 1.0.0 (wordpress-plugin/), on each site. The server checks for the bridge and an active SEO plugin before writing, so nothing is saved if either is missing. get_post and post summaries include seo.
- New schedule_post: schedules a draft, pending or already scheduled post for an exact ISO 8601 time with a timezone (2 minutes to 2 years ahead). Requires confirm_title and confirm_schedule:true. Marked destructive, like publish_post.
- Pages: post_type "page" on list_posts, get_post, create_draft, update_draft, publish_post and schedule_post. Pages use /wp/v2/pages, support parent, reject categories/tags/excerpt, and get ?page_id= preview links.
- Markdown: content_format "markdown" converts content to HTML locally (headings, emphasis, links, images, nested lists, quotes, code, tables, raw HTML). Unsafe link schemes are dropped. New module server/markdown.js, still no dependencies.
- publish_post's future-date error now points to schedule_post.
- Tools: 14 (was 13).

Tool-call migration: none. All new arguments are optional; existing calls behave as before.

## MKT WP Publisher 1.2.0

Workflow features from docs/IMPROVEMENTS.md (F1, F2, F4, F5, F9, F11).

- New list_images: lists the PNG, JPG and WebP files in the selected website's blog image folder (name, type, size, modified), so filenames no longer have to be typed from memory. Reads the local folder only; follows the same folder rules as upload_image.
- New list_posts: finds posts by search text and status, newest-modified first, 50 per page. Defaults to drafts and pending posts; status "all" includes published, scheduled and private.
- New create_term: creates a category or tag. If one with the same name or slug already exists, it is returned with existing:true instead of being duplicated.
- get_post returns a compact summary by default: raw title, content and excerpt, taxonomy, dates, preview link. Pass full:true for the complete WordPress object.
- list_categories and list_tags return compact items ({id, name, slug, count}, plus parent for categories) with names decoded. Pass full:true for complete term objects.
- Draft and pending post summaries include preview_url.
- Sites with plain permalinks work: when /wp-json returns WordPress's HTML 404 page, requests are retried once via ?rest_route= and that form is kept for the site. test_connection reports rest_api_style.
- Tools: 13 (was 10).

Tool-call migration: get_post data and list_categories/list_tags items are now compact by default. Clients that need the old full objects should pass full:true.

## MKT WP Publisher 1.1.1

Fixes from the 2026-10-20 review (docs/IMPROVEMENTS.md B1–B8).

- Error pages that aren't JSON (firewall, CDN or security-plugin HTML) now report the HTTP status and a hint about what may be blocking the REST API, instead of a generic "unreadable response".
- WordPress's own error message is appended to HTTP errors (HTML stripped, at most 200 characters).
- Configuration errors name the website (by ID, or by position in the JSON list) without showing any values.
- update_draft requires at least one field to change; an empty update no longer writes.
- upload_image rejects a blank alt_text.
- The sites_json setting description now says it is for users of earlier JSON setups.
- list_authors falls back to who=authors only on 400/403 rest_* permission errors; 401s, server errors and timeouts are reported at once without a second request.
- Tool annotations: only publish_post is destructiveHint; create_draft, update_draft and upload_image are not. update_draft is idempotentHint.

Tool-call migration: update_draft calls with only site_id and post_id now fail; upload_image calls with a blank alt_text now fail.

## MKT WP Publisher 1.1.0

- Publish as different authors: new list_authors tool returns author_id, name and slug for the selected website (no emails).
- create_draft and update_draft accept an optional author (author_id). Omitted, a new draft is credited to the connected account and an update keeps the current author.
- Post summaries include author. test_connection reports edit_others_posts.
- Clear errors when the connected account cannot credit other authors (needs Editor or Administrator) or the author ID is not on that website.
- list_authors uses the capability filter for Administrator accounts and falls back to who=authors for Editor accounts.

## MKT WP Publisher 1.0.0

- New extension for the MKT team, built from Cibirix WP Publisher 1.2.2 with identical tools and behaviour.
- Display name and MCP server title: MKT WP Publisher. Extension ID and server name: mkt-wp-publisher, so it installs alongside Cibirix WP Publisher without sharing settings.
- Settings are not carried over from Cibirix WP Publisher; enter each website again.
- New icon: an ivory M and coral publishing arrow on the same deep navy rounded square (SVG plus 32, 128 and 512 PNGs).

## Earlier history (Cibirix WP Publisher)

### 1.2.2

- Treat unset settings passed through as literal ${user_config.…} placeholders as empty, so legacy JSON/single-site setups are not blocked by the website-group check.
- Answer initialize, ping, and tools/list immediately instead of queuing them behind slow tool calls; tool calls stay serialized.
- Add list_tags so tag IDs for create_draft/update_draft can be discovered.
- list_categories and list_tags return {items, page, total, total_pages, has_more} from the WordPress paging headers instead of a bare array.
- publish_post refuses drafts with a future date (WordPress would schedule them) and warns if the returned status is not publish.
- publish_post requires confirm_title, which must match the post's current title on the selected site.
- README: team rule to keep publish_post approval manual in Claude Desktop.

Tool-call migration: publish_post now needs confirm_title. list_categories data moved from an array to data.items.

### 1.2.1

- Add the Cibirix C and publishing-arrow icon in PNG sizes 32, 128, and 512.
- Register icons in the extension manifest; include editable SVG artwork.


### 1.2.0

- Add five labeled native website settings groups with enable checkboxes.
- Give each enabled group a required blog image folder and its own credentials.
- Enforce a five-site maximum, including old JSON profiles.
- Return configured folders from list_sites without credentials.
- Use stable IDs website-1 through website-5.
- Preserve old setup as an advanced migration fallback; never fall back when filled groups are all disabled.
- Test different contents under identical filenames and exclusion of other websites' files.
- Use static native field groups; no dynamic Add Website button is claimed.

### 1.1.1

- Rename the displayed extension and MCP server title to Cibirix WP Publisher.
- Add Developed by Jayant to the description and set author credit to Jayant.
- Preserve the internal extension ID and existing configuration for updates.

### 1.1.0

- Add multiple named website profiles in a sensitive extension setting.
- Add list_sites returning only IDs, labels, and canonical URLs.
- Require site_id on all website operations; never select a destination implicitly.
- Pair results with site_id and site_url; keep routing fields out of WordPress payloads.
- Retain legacy single-site configuration as the explicit default site when profiles are empty.
- Process cancellations immediately, skip cancelled queued work, and abort active HTTP requests.
- Allow featured_media:0 to clear a featured image.
- Align draft update text/slug validation and reject inherited schema properties.
- Cover response parsing with the HTTP timeout and report uncertain write outcomes.
- Separate traversal validation from optional symlink tests on Windows.
- Preserve extension identity, dependency-free runtime, HTTPS/redirect checks, draft-first flow, image folder restrictions, and explicit publishing assertion.

Tool-call migration: existing prompts/clients must supply site_id. Site-specific responses now use {site_id, site_url, data}; list_sites uses {sites:[...]}. This is configuration compatibility, not unchanged tool-call compatibility.

Remaining boundaries: caller-supplied publication confirmation relies on the host/user approval flow; draft status and revision checks are not atomic with external editors; duplicate prevention is not durable idempotency; cancellation cannot undo an already committed write. No scheduling, SEO-plugin metadata, or custom post types were added.
