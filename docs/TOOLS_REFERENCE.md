# Tools Reference

A successful call returns the result twice: as JSON text in a text content block, and as `structuredContent` (MCP 2025-06-18). Every tool declares an `outputSchema` for it. Errors come back as `isError: true` with a plain-text message and no `structuredContent`.

Every tool except `list_sites` requires `site_id` (pattern `^[a-z0-9]+(?:-[a-z0-9]+)*$`) and returns:

```json
{ "site_id": "website-1", "site_url": "https://example.com", "data": { } }
```

Unknown arguments are always rejected.

**Read-only websites:** on a website with `read_only` (setting *Website N | Read-only*, or `"read_only": true` in a JSON profile), every tool whose `readOnlyHint` is false is refused before any request is made, with an error that names the website. `list_sites` reports `read_only: true` for it.

**Post types:** `list_posts`, `get_post`, `list_blocks`, `edit_blocks`, `create_draft`, `update_draft`, `edit_published_post`, `publish_post`, `unpublish_post`, `schedule_post` and `upload_image` (for `featured_for_post_id`) take an optional `post_type`:
- `post` (default) and `page` need no lookup. Pages use `/wp/v2/pages`; they don't take `categories`, `tags` or `excerpt`, but they can have a `parent` page.
- **Any other post type the site offers over the REST API** works too, for example `product` (WooCommerce) or `locations`. On first use per site, the tool reads `/wp/v2/types/{type}`, `/wp/v2/taxonomies?type={type}` and the type's schema (`OPTIONS`), then caches them.
  - `categories` means the type's hierarchical taxonomy (`product_cat` on products), and `tags` its flat one (`product_tag`).
  - Fields the type's schema lacks are refused.
  - WordPress internal types (`attachment`, `wp_template`, `wp_block`, …) are refused.
- `create_draft` refuses `product`: create products in WordPress, so price and stock are set up correctly.

Keep `post_type` paired with the ID, the same way you keep `site_id`.

**Annotations:** read-only tools are `readOnlyHint: true, idempotentHint: true`. Only the tools that change public content are `destructiveHint: true`: `update_term`, `edit_published_post`, `edit_blocks`, `update_fields`, `update_elementor_layout`, `publish_post`, `unpublish_post`, `schedule_post` and `update_product`. `update_draft` is `idempotentHint: true`; `create_draft` and `upload_image` are not idempotent. All tools are `openWorldHint: true` except `list_images`, which reads only the local folder.

**Plain permalinks:** if `/wp-json/...` returns WordPress's HTML 404 page, the server retries that request once as `/?rest_route=/wp/v2/...`. It keeps using that form for the site until the extension restarts. The retry is safe for writes, because an unrouted 404 means WordPress processed nothing.

**Retries and timeouts:** reads (`GET`, `OPTIONS`) that get 429, 502, 503 or 504 are retried up to twice, after 1 s and 3 s, or after the `Retry-After` header (capped at 10 s). Writes are never retried. Each request times out after 60 s; image uploads after 180 s.

**Concurrency guard:** `update_draft`, `edit_published_post`, `edit_blocks`, `preview_edit`, `stage_edit`, `publish_post`, `unpublish_post` and `schedule_post` accept `expected_modified_gmt`, the `modified_gmt` value from `get_post` or `list_posts`. If the post was changed in WordPress since then, the call fails and nothing is written. A trailing `Z` or `+00:00` is ignored when comparing.

---

## list_sites
Read-only. No network calls.

**Args:** none
**Returns:** `{ sites: [{ site_id, label, site_url, image_folder? }], max_sites: 5 }`

## test_connection
Read-only. `GET /users/me?context=edit`

**Returns `data`:** `{ connected, user_id, name, slug, roles, permissions: { upload_files, publish_posts, edit_posts, edit_others_posts }, rest_api_style, note }`

Capabilities are what WordPress reports. No write is attempted. `rest_api_style` is `pretty (/wp-json)` or `plain (?rest_route=)`.

## get_site_context
Read-only. The first call on a site you have not worked on. Every lookup except the site index is optional: an account that cannot read plugins or settings still gets the rest, with `notes` saying what was not available.

Reads `/` (site index), `/users/me`, `/settings`, `/plugins?status=active` (administrators), `/themes?status=active`, `OPTIONS /posts` (SEO Bridge) and `/types`.

**Returns `data`:** `site` (name, description, url, language, timezone, `rest_api_style`), `access` (`mode`: `read_only` on a read-only website, else `full`; user, `can_publish`, `can_upload`, `can_edit_others`, `is_administrator`), `theme` (name, stylesheet, parent, version, `block_theme`), `plugins` (SEO plugin, store, custom fields, page builders, multilingual, forms, cache; `detected_from` is the plugin list for administrators, otherwise REST API namespaces), `seo_bridge` (installed, version, plugin), `post_types`, `guidance` and `notes`.

## get_brand_styles
Read-only. The active theme's `theme.json` presets merged with changes saved in the Site Editor (global styles).

**Returns `data`:** `theme`, `colors` (slug, name, value, CSS variable), `gradients`, `font_sizes`, `font_families`, `spacing_sizes`, `layout` (content and wide size), `base_styles` (background, text, link, heading and body fonts, body size, button colours), `how_to_use` (refer to presets by slug in block attributes, such as `{"textColor":"<slug>"}`) and `notes`.

## list_authors
Read-only.

| Arg | Type | Notes |
| --- | --- | --- |
| `search` | string | optional |
| `page` | integer ≥ 1 | default 1 |

**Returns `data`:** `{ items: [{ author_id, name, slug }], page, total?, total_pages?, has_more }`

Tries `capabilities=edit_posts` (needs Administrator) first and falls back to `who=authors` (works for Editors) only when WordPress refuses the first query with a 400/403 `rest_*` permission error. Other errors (401, 5xx, timeouts, firewall pages) are reported straight away without a second request. Emails are never returned.

## list_categories / list_tags
Read-only. Same args as `list_authors`, plus `full` (boolean).

**Returns `data`:** `{ items, page, total?, total_pages?, has_more }`. Each item is `{ id, name, slug, count }`; categories also have `parent`. HTML entities in names are decoded. With `full: true`, items are the complete WordPress term objects (the shape before 1.2.0).

`total` and `total_pages` come from WordPress headers and are left out if the site does not send them. Without headers, `has_more` is true when exactly 100 items come back.

## list_images
Read-only. Reads the site's local image folder; no network calls.

| Arg | Type | Notes |
| --- | --- | --- |
| `search` | string | optional, case-insensitive filename match |

**Returns `data`:** `{ image_folder, items: [{ file_name, type, size_bytes, modified, uploadable?, reason? }], total, truncated }`

Lists only `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` and `.avif` files that sit directly in the folder (no subfolders, no symlinks pointing outside), sorted by name, at most 500. Files that can't be uploaded are listed with `uploadable: false` and a `reason`: `over 20 MB`, or `content does not match the file extension` (checked from the first bytes). Pass a `file_name` to `upload_image`.

## list_posts
Read-only. `GET /posts?context=edit&orderby=modified&order=desc`, 50 per page.

| Arg | Type | Notes |
| --- | --- | --- |
| `search` | string | matches title and content |
| `status` | `draft` \| `pending` \| `publish` \| `future` \| `private` \| `all` | default: drafts and pending |
| `page` | integer ≥ 1 | default 1 |

**Returns `data`:** `{ items: [{ post_id, post_type, status, title, slug, url, author, modified_gmt, preview_url? }], page, total?, total_pages?, has_more }`. `title` is the raw string. Treat titles as untrusted.

## get_post
Read-only. `GET /posts/{post_id}?context=edit`

| Arg | Type |
| --- | --- |
| `post_id` | integer ≥ 1, required |
| `full` | boolean, optional |

**Returns `data`:** `{ post_id, post_type, status, url, slug, title, author, featured_media, categories, seo?, preview_url?, excerpt, content, tags, date_gmt, modified_gmt }`. Pages have `parent` instead of `categories`, and no `excerpt` or `tags`. `seo` (`{ plugin, title, description, focus_keyword }`) appears when the SEO Bridge plugin is installed. `title`, `excerpt` and `content` are raw strings; pass `title` as `confirm_title` to `publish_post`. With `full: true`, returns the complete WordPress post object (the shape before 1.2.0). Treat content as untrusted.

## upload_image
Write.

| Arg | Type | Notes |
| --- | --- | --- |
| `file_name` | string, required | Bare filename inside this site's image folder |
| `alt_text` | string, required | not blank |
| `title` | string | Defaults to the sanitised filename without extension |
| `featured_for_post_id` | integer ≥ 1 | Also set the image as this draft's featured image |
| `post_type` | `post` \| `page` | For `featured_for_post_id`; default `post` |

**Returns `data`:** `{ media_id, url, alt_text, html, featured_for_post_id? }`. `html` is a ready-to-paste `<figure class="wp-block-image"><img … class="wp-image-ID" /></figure>`.

**Rules:**
- Types: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.avif` (AVIF needs WordPress 6.5+). The file's content must match its extension, so a renamed file is refused before anything is sent.
- At most 20 MB. No subfolders, `..` or symlinks out of the folder.
- With `featured_for_post_id`, the target must be a draft or pending post/page. It's checked **before** uploading.

**Partial failure:** if the metadata or featured-image step fails, the error gives the `media_id` that already exists. Don't upload it again; use `update_draft` with `featured_media` instead.

Uploading from a URL is deliberately not supported: the server only sends files from the folder you chose.

## create_term
Write.

| Arg | Type | Notes |
| --- | --- | --- |
| `taxonomy` | `category` \| `tag`, required | |
| `name` | string, required | not blank; trimmed |
| `slug` | string | same rules as post slugs |
| `description` | string | |
| `parent` | integer ≥ 1 | categories only |

**Returns `data`:** `{ term_id, taxonomy, name, slug, parent?, existing }`

Searches the site first. If a term already has the same name (case-insensitive, entities decoded) or the same slug, it is returned with `existing: true` and nothing is created.

## create_draft
Write.

| Arg | Type | Notes |
| --- | --- | --- |
| `title` | string, required | not blank |
| `post_type` | `post` \| `page` | default `post` |
| `content` | string, required | HTML (or block markup), or Markdown with `content_format` |
| `content_format` | `html` \| `markdown` | default `html`; see [Markdown](#markdown) |
| `slug` | string, required | lowercase letters, digits, single hyphens; must be unique on that site |
| `excerpt` | string | |
| `categories` | integer[] | IDs from `list_categories` on the same site |
| `tags` | integer[] | IDs from `list_tags` on the same site |
| `featured_media` | integer ≥ 0 | media ID on the same site |
| `author` | integer ≥ 1 | `author_id` from `list_authors`; needs an Editor/Admin connection |
| `parent` | integer ≥ 0 | pages only; parent page ID, `0` = top level |
| `seo` | object | `{ title?, description?, focus_keyword? }`, at least one; see [SEO fields](#seo-fields) |

`excerpt`, `categories` and `tags` are for posts only.

**Returns `data` (summary):** `{ post_id, post_type, status, url, slug, title, author, featured_media, categories, seo?, preview_url, warning? }` (pages have `parent` instead of `categories`). `preview_url` is `<site>/?p=ID&preview=true` for posts or `<site>/?page_id=ID&preview=true` for pages. It's included for any status except `publish`; open it while logged in to WordPress.

Status is always `draft`. Fails if the slug already exists for that post type in draft, pending, future, publish or private.

## update_draft
Write. For `draft`, `pending` and scheduled (`future`) posts. A scheduled post keeps its publish time; to move the time use `schedule_post`, to cancel it use `unpublish_post`. Published posts are refused (use `edit_published_post`).

Args: `post_id` (required), `post_type` (the same one the item was created with), optional `expected_modified_gmt`, plus at least one `create_draft` field. `content_format` needs `content`. Calling it with no field to change is an error and sends nothing. `featured_media: 0` removes the featured image.

A new `slug` is checked against the other posts of that type first, and taken slugs are refused. If WordPress still saves a different slug, the summary includes a `warning`.

**Returns `data`:** post summary. If WordPress returns a different status than before, a `warning` says so.

## edit_published_post
Write. **Changes public content immediately.** Use only after the user explicitly approves this site, this post and the change.

Args: `post_id` (required), `post_type`, `confirm_title` (required: the **current** title, even when changing the title), `confirm_edit: true` (required), optional `expected_modified_gmt`, plus at least one field from `create_draft` (`title`, `content`/`content_format`, `slug`, `excerpt`, `categories`, `tags`, `featured_media`, `author`, `parent`, `seo`) or `publish_date`.

- Works on `publish` and `private` posts/pages only; drafts and scheduled posts point to `update_draft`.
- `publish_date`: ISO 8601 with a timezone, now or in the past. It changes the post's date (back-dating).
- A changed `slug` is checked against other posts, and the result warns that the public URL changed.
- To swap images: upload with `upload_image`, then pass the new `media_id` as `featured_media`, or put its `html` into `content`.
- To change the meta title/description: `seo: { title, description }` (needs the SEO Bridge plugin).

**Returns `data`:** post summary (with `seo` when written), plus a `warning` when something needs checking.

## publish_post
Write. **Use only after the user explicitly approves this site and this post.**

| Arg | Type | Notes |
| --- | --- | --- |
| `post_type` | `post` \| `page` | default `post` |
| `post_id` | integer ≥ 1, required | |
| `confirm_title` | string, required | Must match the current title (whitespace-normalised) |
| `confirm_publish` | `true`, required | |
| `publish_date` | string | optional back date: ISO 8601 with a timezone, now or in the past |
| `expected_modified_gmt` | string | optional concurrency guard |

**Behaviour:**
- Title mismatch → error, nothing changes.
- Already `publish` → returns the summary, no write. With `publish_date` → error pointing to `edit_published_post`.
- Status other than `draft`/`pending` → error.
- With `publish_date`: sends `{ status: 'publish', date_gmt }` and returns `published_at_gmt`. A future `publish_date` is refused (use `schedule_post`).
- Without `publish_date`: a `date_gmt` more than 60 s in the future → error pointing to `schedule_post`, or to `publish_date` to publish now.
- WordPress returns a status other than `publish` → summary plus `warning`.

## schedule_post
Write. **Use only after the user explicitly approves this site, this post and this time.** WordPress then publishes it automatically, with no further approval.

| Arg | Type | Notes |
| --- | --- | --- |
| `post_type` | `post` \| `page` | default `post` |
| `post_id` | integer ≥ 1, required | |
| `publish_at` | string, required | ISO 8601 with a timezone: `2026-11-02T09:00:00+05:30` or `2026-11-02T03:30:00Z` |
| `confirm_title` | string, required | Must match the current title (whitespace-normalised) |
| `confirm_schedule` | `true`, required | |
| `expected_modified_gmt` | string | optional concurrency guard |

**Behaviour:**
- The time must be at least 2 minutes and at most 2 years ahead. A time without a timezone is refused, so nothing depends on the site's timezone setting.
- Works on `draft`, `pending` and already-scheduled (`future`) posts. Calling it again on a scheduled post moves the time.
- Sends `{ status: 'future', date_gmt }`.
- **Returns `data`:** the summary plus `publish_at_gmt`. If WordPress returns a status other than `future`, a `warning` is added.
- To cancel a schedule, use `unpublish_post`.

## unpublish_post
Write. **Takes content off the public site.** Use only after the user explicitly approves this site and this post.

| Arg | Type | Notes |
| --- | --- | --- |
| `post_type` | `post` \| `page` | default `post` |
| `post_id` | integer ≥ 1, required | |
| `confirm_title` | string, required | Must match the current title |
| `confirm_unpublish` | `true`, required | |
| `expected_modified_gmt` | string | optional concurrency guard |

**Behaviour:**
- Works on `publish`, `private`, `future` (scheduled) and `pending` posts/pages, and sends `{ status: 'draft' }`. An existing draft is returned unchanged, with no write.
- **Returns `data`:** the summary plus `previous_status`. A formerly scheduled post keeps its future date; the `warning` says to use `schedule_post` again, or `publish_post` with `publish_date` to publish it now.

## preview_edit
Read-only: writes nothing. Takes the same fields as `update_draft` / `edit_published_post` (title, content, `content_format`, slug, excerpt, categories, tags, featured image, author, parent, SEO, `publish_date`) or `changes` as for `edit_blocks`, plus `expected_modified_gmt`, `allow_page_builder` and `allow_content_loss`.

**Returns `data`:** each field before and after, the paragraphs removed and added, text and media counts before and after, `content_loss` when the change would be refused by the content-loss check, a `warning` (page builder, content loss, URL change, nothing to change), and `apply_with` (the tool to use, with `expected_modified_gmt`). Show it to the user and get approval before applying.

## stage_edit
Write, but the live post does not change: saves the proposed title, content or excerpt (or `changes` as for `edit_blocks`) as a WordPress **autosave** of a published or private post (`POST {route}/{id}/autosaves`), so the user can open it in the WordPress editor and preview it. Drafts are refused: change them with `update_draft` and review them at their `preview_url`. The content-loss and page-builder checks apply.

**Returns `data`:** the same preview as `preview_edit`, plus the editor link and `apply_with`.

## Checks on content changes
`update_draft`, `edit_published_post`, `edit_blocks` and `stage_edit` refuse a content change, with nothing written, when:

- **The page is built with a page builder.** For builders that keep the layout in their own data (Elementor, Bricks, Beaver Builder, Breakdance, Oxygen), changing the content would not change the page. For WPBakery, Divi and Avada, a full replacement would remove the layout; `edit_blocks` with `replace_text` still works inside it. SEO Bridge 1.4.0+ (`mkt_builder`) makes the detection exact; without it the stored and rendered content and the page template are checked. Other fields (title, slug, excerpt, featured image, taxonomy, author, SEO) can still be changed. Pass `allow_page_builder: true` only if the user explicitly wants this anyway. For Elementor pages use `get_elementor_layout` / `update_elementor_layout`.
- **Most of the content would be lost.** The change keeps less than half of the visible text (posts of 200+ characters), or less than half of the images, videos and embeds (3 or more), or leaves an image or embed without a source. Pass `allow_content_loss: true` only if the user explicitly wants to remove that content.

On ordinary posts these checks need no extra request: the edit sends exactly the same requests as before.

## list_blocks
Read-only. `GET /{route}/{post_id}?context=edit` (raw content).

| Arg | Type | Notes |
| --- | --- | --- |
| `post_type` | post type slug | default `post` |
| `post_id` | integer ≥ 1, required | |

**Returns `data`:** `{ post_id, post_type, status, title, modified_gmt, uses_blocks, blocks: [{ block, name, text?, inner_blocks?, fields? }], total, truncated }`.
- `block` is the number to use with `edit_blocks`: `"3"` for a top-level block, `"2.0.1"` for nested ones.
- Classic HTML between blocks (or a whole classic post) appears as `name: "html"`.
- `fields` lists an ACF block's data fields (the `_field` keys are hidden).
- At most 300 entries are listed.

## edit_blocks
Write. **Use only after the user explicitly approves this site, post and change.** Published content changes immediately.

| Arg | Type | Notes |
| --- | --- | --- |
| `post_type` | post type slug | default `post` |
| `post_id` | integer ≥ 1, required | |
| `changes` | list of 1–50 objects, required | see below |
| `confirm_title` | string, required | the current title |
| `confirm_edit` | `true`, required | |
| `expected_modified_gmt` | string | optional concurrency guard |

Each change is one of:
- `{ "block": "1", "replace_text": { "find": "…", "with": "…", "all": false } }`: text inside that block's own HTML. Text in nested blocks is targeted by their own number.
- `{ "replace_text": { "find": "…", "with": "…", "all": false } }`: anywhere in the content, outside block delimiters and attributes.
- `{ "block": "5", "acf_data": { "field_name": "value" } }`: existing fields of an ACF block. Text, numbers or true/false.

**Rules:**
- The text must match exactly once, unless `all: true`. If it isn't found as written, it's retried HTML-escaped (`&` → `&amp;`).
- Text containing `<!--` or `-->` is refused. Changes may not overlap.
- After editing, the content must parse to exactly the same block structure, or nothing is saved.
- ACF block attributes are re-serialized the way WordPress does (`--`, `<`, `>`, `&` and `\"` escaped), so the block comment stays valid.
- Only `content` is sent.

**Returns `data`:** summary, `changes` (before/after per edit), `edits`, `live`, `undo` (WordPress Revisions), and a `warning` if WordPress altered the content on save, for example removing HTML the account may not post.

## inspect_fields
Read-only. Needs SEO Bridge 1.3.0+ (checked with `OPTIONS` on the item's route; the answer is cached per site and route).

| Arg | Type | Notes |
| --- | --- | --- |
| `post_id` | integer ≥ 1 | with `post_type` (default `post`) for posts, pages, products and other types |
| `post_type` | post type slug | |
| `taxonomy` + `term_id` | slug + integer ≥ 1 | for categories, tags and product categories instead of `post_id` |

Sends `GET {route}/{id}?context=edit&mkt_fields=1`. The bridge computes the fields only for requests that ask for them.

**Returns `data`:** the item (`post_id`, `post_type`, `status`, `title`, `url`, `modified_gmt`, or `term_id`, `taxonomy`, `name`, `link`), `source` (`acf` or `none`), `acf_version`, `bridge_version`, and:
- `paths`: every value as `{path, type, writable, value}`, with the value shortened to 80 characters and HTML removed. At most 300; `paths_truncated` is set if there are more.
- `fields`: each top-level ACF field by name, `{key, label, type, writable, value, sub_fields?, layouts?, choices?, multiple?, min?, max?}`. Values are ACF's stored values (images and posts as IDs), with sub fields by name. Repeater and flexible content values are lists of rows; flexible rows carry `acf_fc_layout`.
- `meta`: listed meta keys as `{value, writable}`.
- `note` when nothing is found (no field group shown on the item, or ACF not active and no meta keys listed).

## update_fields
Write. **Use only after the user explicitly approves this site, item and change.** Published items and terms change immediately.

| Arg | Type | Notes |
| --- | --- | --- |
| `post_id` + `post_type`, or `taxonomy` + `term_id` | | as for `inspect_fields` |
| `changes` | list of 1–50 objects, required | see below |
| `confirm_title` | string, required | the current title (the name, for terms) |
| `confirm_edit` | `true`, required | |
| `expected_modified_gmt` | string | posts only; terms have no modified date |

Each change is one of:
- `{ "path": "faqs[1].answer", "value": "…" }`: set one value. Paths: `name`, `group.sub`, `repeater[row].sub`, `flexible[row].sub`, nested as deep as needed (`full_page_content[1].2_column_content_row[0].2_column_content_text`). Rows are numbered from 0.
- `{ "path": "…", "replace_text": { "find": "…", "with": "…", "all": false } }`: change part of a text value; it must match exactly once unless `all: true`.
- `{ "path": "faqs[1]", "value": { "answer": "…" } }`: merge sub fields into one row. A flexible content row keeps its layout.
- `{ "path": "faqs", "value": [ … ] }`: replace a whole field, which is how rows are added or removed.
- `{ "meta": "city_intro", "value": "…" }`: a listed meta key; `null` removes it.

**Rules:**
- The tool reads the current values and changes only the addressed value. It then sends each changed top-level field whole (`POST {route}/{id}` with `{mkt_fields: {fields: {name: value}, meta: {…}}}`), so other rows, layouts and sub fields are sent back exactly as stored.
- Checked by the extension: the path exists, the row exists, the field is writable, and the value type fits (text, number, media ID, list of rows, …).
- Checked again by the bridge before anything is saved: choices, that media IDs are attachments, maximum rows, layouts and sub field names. If any change fails, nothing is saved.
- HTML is filtered like post content for accounts without the `unfiltered_html` capability.
- Changes that leave every value as it is are refused.

**Returns `data`:** the item, `changes` (`{path or meta, before, after}`), `live`, `restore.changes` (the previous whole values; pass them back to `update_fields` to undo), `undo`, and a `warning` if WordPress stored a value differently from what was sent.

## list_block_types
Read-only. No plugin needed: WordPress core's `GET /wp/v2/block-types[/{namespace}]?_fields=name,title,description,category,parent,ancestor,is_dynamic`.

| Arg | Type | Notes |
| --- | --- | --- |
| `namespace` | string | `core`, `acf`, `woocommerce`, … (lowercase letters, digits and hyphens) |
| `category` | string | block category such as `text`, `design`, `widgets` |
| `search` | string | matches name, title and description, ignoring case |

**Returns `data`:** `count`, `namespaces` (count per namespace), `block_types` (`{name, title, category, description (120 characters), parent?, ancestor?, dynamic?}`, sorted by name) and a `note` on `parent`/`ancestor`.

## get_block_type
Read-only. `name` must include the namespace, e.g. `core/heading` or `acf/faq`. Sends `GET /wp/v2/block-types/{name}`.

**Returns `data`:** `name`, `title`, `description`, `category`, `dynamic`, `attributes` (each `{type, enum?, default?, source?, selector?, attribute?}`; values with a `source` live in the block's HTML, not in the comment's JSON; `lock` and `metadata` are left out), `supports`, `parent`, `ancestor`, `allowed_blocks`, `styles`, `variations` (up to 50, with their attributes) and `how_to_write`. A block the site does not have gives a clear error naming the site.

## check_blocks
Read-only. `content` (required) is block markup. Parses it with the same block grammar as `edit_blocks`; unbalanced block comments are reported without a request. Otherwise reads the site's block types once and checks every block:
- **problems** (`ok: false`): block types the site does not have (`unknown_block_types` lists them), attribute types and `enum` values, `parent` (direct parent), `ancestor` (somewhere above), `allowed_blocks` (children).
- **warnings:** attributes the block does not register (global ones such as `className`, `style`, `lock`, `metadata`, `align`, colors and `layout` are not reported), attributes that are read from HTML, and static blocks written as self-closing comments.

It cannot check that a static block's HTML matches its `save()` output; the editor reports that when the content is opened.

## get_elementor_layout
Read-only. Needs SEO Bridge 1.5.0+ and Elementor 3.0+ (checked with `OPTIONS` on the item's route via `mkt_elementor.source`/`version`; cached per site and route).

| Arg | Type | Notes |
| --- | --- | --- |
| `post_id` | integer ≥ 1, required | with `post_type` (default `post`) |
| `post_type` | post type slug | |
| `widgets` | boolean | also return `widget_types`, the widgets registered with Elementor on the site |
| `full` | boolean | also return `elements`, the complete layout JSON |

Sends `GET {route}/{id}?context=edit&mkt_elementor=1`.

**Returns `data`:** the item (`post_id`, `post_type`, `status`, `title`, `url`, `modified_gmt`, `preview_url` for unpublished items), `built_with_elementor`, `editable` (Elementor allows this account and post type), `elementor_version`, `bridge_version`, `template`, `page_settings`, `outline` (`{element, path, depth, type, text?, children?}` for up to 400 elements; `type` is the widget type for widgets), `total_elements`, `outline_truncated`, and a `note` for pages not built with Elementor, built with another builder, not editable, or open in someone else's editor.

## update_elementor_layout
Write. **Use only after the user explicitly approves this site, page and change.** Published pages change immediately.

| Arg | Type | Notes |
| --- | --- | --- |
| `post_id`, `post_type` | | as above |
| `changes` | list of 1–50 objects | targeted changes, see below; or |
| `elements` | list of objects | the whole new layout (sections/containers → columns → widgets, as Elementor stores them). Elements without `id` get a new 7-character id |
| `page_settings` | object | merged into the page's Elementor settings; `null` removes one. `template` must be `default`, `elementor_canvas`, `elementor_header_footer`, `elementor_theme` or one of the theme's page templates. `post_*`, `menu_order`, `comment_status` and `ping_status` are refused |
| `convert` | boolean | needed to switch a page that is not built with Elementor; its current content is replaced |
| `confirm_title` | string, required | the current title |
| `confirm_edit` | `true`, required | |
| `expected_modified_gmt` | string | concurrency guard |

Each change is one of:
- `{ "element": "3f2a9c1", "settings": { "title": "New", "header_size": null } }`: merge settings into one element; `null` removes a setting.
- `{ "element": "3f2a9c1", "replace_text": { "find": "…", "with": "…", "all": false } }`: replace text in that element's settings, including rows of repeaters (icon lists, tabs…). Must match exactly once unless `all: true`.
- `{ "remove": "3f2a9c1" }`: remove an element and everything inside it.
- `{ "insert": {…} or [ … ], "parent": "id" or null, "position": 0 }`: insert elements into a parent (`null` = top level) at a position (default: the end). Missing `id`, `settings` and `elements` are filled in.

**Checks before any write (in the extension, then again in the bridge):** title and modified date; not in the trash; not owned by another page builder; nobody else has it open in an editor (WordPress's post lock); Elementor allows this account and post type; `convert` for pages not built with Elementor; ids unique and well formed; nesting (top level: sections or containers; sections hold columns; columns hold widgets or one level of inner section; containers hold containers and widgets; widgets hold nothing); widgets registered on the site; at most 5,000 elements, 30 levels and 5 MB; changes that leave everything as it is are refused. Accounts without `unfiltered_html` get settings text filtered with `wp_kses_post` and cannot use the HTML widget.

Sends `POST {route}/{id}` with `{mkt_elementor: {elements?, page_settings?, convert?}}`. The bridge saves through Elementor's `Document::save()`, so Elementor regenerates the page CSS, records its version, and keeps a revision.

**Returns `data`:** the item, `changes` (one entry per change, or `{replaced_layout, elements_before}`), `total_elements`, `live`, `converted_to_elementor`, `restore.elements` (the previous layout, when under 60 KB; pass it back as `elements` to undo), `undo`, and a `warning` if Elementor stored the layout differently from what was sent.

## queue_editor_changes
Write, but it never changes the post: it adds a proposal to the post's editor queue (SEO Bridge 1.5.0+, REST namespace `mkt-seo-bridge/v1`).

| Arg | Type | Notes |
| --- | --- | --- |
| `post_id`, `post_type` | | |
| `changes` | list of 1–50 objects | block edits, exactly as in `edit_blocks`; or |
| `content` | string | the whole new content; `content_format: "markdown"` converts it |
| `label` | string | shown in the editor notice; default "Changes from Claude" |
| `expected_modified_gmt` | string | concurrency guard |

Reads the post (`context=edit`), computes the new content from the saved content, reads the queue (which also confirms the bridge supports it), then `POST /mkt-seo-bridge/v1/editor-queue/{id}` with `{content, base_modified_gmt, label, summary}`. Refused: posts in the trash, pages owned by a page builder (`mkt_builder`), and changes that leave the content as it is.

**Returns `data`:** the post, `batch_id`, `queue_status` (`pending`), `label`, `changes`, `edit_url`, and `next`.

In the block editor, the bridge's script checks the queue every 15 seconds while the tab is visible and shows each pending change as a notice with **Apply** and **Dismiss**. Apply replaces the editor's blocks only when the editor has no unsaved changes and the post's `modified_gmt` equals the change's `base_modified_gmt`; the person then saves or undoes. Changes expire after 14 days; at most 20 can be pending per post.

## list_editor_changes
Read-only. Returns the post, `bridge_version`, `pending` (count), `edit_url`, and `items`, newest first: `{batch_id, status (pending | applied | dismissed), label, created_gmt, updated_gmt, edits, summary, stale?, saved?, note?}`. `stale` means the post was saved after the change was prepared, so the editor will refuse it. `saved` compares an applied change with the saved content (whitespace between tags ignored).

## cancel_editor_change
Write (the queue only). `batch_id` (16 hex characters) from `queue_editor_changes` or `list_editor_changes`. Dismisses a pending change; an applied or dismissed one is left as it is and reported in `note`.

## list_terms / get_term / update_term
Any taxonomy: `category`, `post_tag`, `product_cat`, `product_tag`, or custom. `category` and `post_tag` need no lookup. Others are looked up once per site via `/wp/v2/taxonomies/{taxonomy}`. WordPress internal taxonomies (`nav_menu`, `post_format`, …) are refused.

- `list_terms(taxonomy, search?, parent?, page?)` returns `{ items: [{ term_id, taxonomy, name, slug, parent?, count, link }], page, total?, total_pages?, has_more }`, 100 per page.
- `get_term(taxonomy, term_id)` returns `{ term_id, taxonomy, name, slug, description, parent?, count, link, seo? }`.
- `update_term(taxonomy, term_id, name?, slug?, description?, parent?, seo?, confirm_name, confirm_edit)`. **Write; the term's archive page changes immediately.**
  - `confirm_name` must match the current name.
  - A new slug that's taken is refused, and a changed slug warns that the archive URL changed.
  - `parent` is only for hierarchical taxonomies.
  - `seo` needs SEO Bridge 1.2.0+ (it's checked with `OPTIONS` before anything is saved). When `seo` is sent, the current name is sent as well, so WordPress runs a normal term save and Yoast/Rank Math refresh their cached data.

## create_product
Write, **always as a draft**. There is no status argument, so it cannot publish.

- Args: `name` and `regular_price` (required), plus `slug`, `description`, `short_description`, `sale_price`, `sku`, `stock_status`, `manage_stock`, `stock_quantity` (needs `manage_stock: true`), `weight`, `dimensions {length, width, height}`, `categories` (product_cat IDs), `tags`, `images` (media IDs, the first is the main image) and `attributes [{name, options[], visible?}]`. Attributes are plain product attributes, not variations.
- Checked before anything is created: the SKU must be unused (`GET /wc/v3/products?sku=`), and the sale price must be below the regular price.
- Sends `POST /wc/v3/products` with `{type: "simple", status: "draft", …}`.
- Returns the product summary plus `preview_url`, and a `warning` if WooCommerce returns any status other than draft.

## get_product / update_product
WooCommerce store data, through `wc/v3`. Needs WooCommerce, and an account with the Shop Manager or Administrator role.

- `get_product(product_id)` returns `{ product_id, name, type, status, permalink, sku, regular_price, sale_price, price, on_sale, stock_status, manage_stock, stock_quantity, short_description, categories, images, attributes, variations, date_modified_gmt }`.
- `update_product(product_id, regular_price?, sale_price?, sku?, stock_status?, short_description?, categories?, images?, confirm_title, confirm_edit, expected_modified_gmt?)`. **Write; live in the store immediately.**
  - Prices are plain numbers as text (`"1299.99"`). `sale_price: ""` removes the sale; `regular_price` can't be emptied.
  - The sale price must be lower than the regular price.
  - Variable products are refused for prices, since those are set per variation.
  - `categories` are `product_cat` IDs; `images` are media IDs, and the first is the main image.
  - `confirm_title` must match the current product name (HTML entities are decoded before comparing).
  - Sent as `PUT /wc/v3/products/{id}`. Returns the summary plus `changed` (before/after per field).
- For a product's title, long description, slug and SEO, use `update_draft` / `edit_published_post` / `edit_blocks` with `post_type: "product"`.

## SEO fields

`create_draft`, `update_draft`, `edit_published_post` (any post type) and `update_term` accept `seo: { title?, description?, focus_keyword?, canonical? }`. An empty string clears a value. `canonical` must be a full `http://` or `https://` URL.

This needs the **MKT Publisher SEO Bridge for Yoast & Rank Math** plugin (`wordpress-plugin/` in the source) on each site, plus **Yoast SEO** or **Rank Math**. Neither SEO plugin exposes these fields to the REST API on its own. The bridge adds a REST field, `mkt_seo`, that maps to:

| Field | Yoast SEO meta | Rank Math meta | Max length | Bridge |
| --- | --- | --- | --- | --- |
| `title` | `_yoast_wpseo_title` | `rank_math_title` | 300 | 1.0.0+ |
| `description` | `_yoast_wpseo_metadesc` | `rank_math_description` | 1,000 | 1.0.0+ |
| `focus_keyword` | `_yoast_wpseo_focuskw` | `rank_math_focus_keyword` | 200 | 1.0.0+ |
| `canonical` | `_yoast_wpseo_canonical` | `rank_math_canonical_url` | 2,048 | 1.1.0+ |

**Products, custom post types and terms (bridge 1.2.0+):**
- **Products and custom post types:** from 1.2.0, the field is on every public post type, stored in the same post meta as above.
- **Categories, tags and product categories:** `update_term` uses the same `seo` object.
  - **Yoast** keeps term SEO in the option `wpseo_taxonomy_meta` → `[taxonomy][term_id]` → `wpseo_title`, `wpseo_desc`, `wpseo_focuskw`, `wpseo_canonical`. The bridge changes only those four keys, so the term's other Yoast settings (noindex, social and so on) stay as they are.
  - **Rank Math** keeps it in term meta: `rank_math_title`, `rank_math_description`, `rank_math_focus_keyword`, `rank_math_canonical_url`.

Before any write that includes `seo`, the server sends `OPTIONS` to the endpoint to read the bridge's schema: the active SEO plugin, and from 1.1.0 the bridge version and supported fields. The call fails **before anything is saved** if:
- the bridge is missing;
- no SEO plugin is active;
- a field needs a newer bridge (for example `canonical` on 1.0.0).

A positive result is cached until restart. If both SEO plugins are active, Yoast is used. Values go through WordPress's `sanitize_text_field` (tags stripped); canonical URLs go through `esc_url_raw`. Variables like `%%title%%` are kept. Read results include `seo.version` with bridge 1.1.0.

On existing posts, bridge 1.1.0 saves the values before WordPress saves the post, so Yoast rebuilds its cached page data (its "indexable") with the new values. Edits to live posts therefore show immediately.

## Markdown

With `content_format: 'markdown'`, `content` is converted to HTML locally before it's sent. Supported: headings, paragraphs, **bold**, *italic*, ~~strike~~, `code`, links, images, ordered/unordered/nested lists, blockquotes, fenced code blocks, horizontal rules, GFM pipe tables and raw HTML blocks.

- Soft line breaks become spaces (WordPress would otherwise turn them into `<br>`). End a line with two spaces or `\` for a hard break.
- Links and images using `javascript:`, `data:` or other non-web schemes are dropped and only their text is kept.
- The output is plain HTML. The block editor shows it as a Classic block, which has a one-click "Convert to blocks".

---

## Common errors

| Message starts with | Meaning / action |
| --- | --- |
| `Missing site_id` / `Unknown site_id` | Call `list_sites` first. |
| `Site website-N …` / `Site <id> …` / `Site number N …` | A website's settings are incomplete or invalid. The message names which one (by ID, or by position in the JSON list) but never shows its values. |
| `WordPress HTTP <status> (<code>): <message>.` | WordPress's own error text (HTML stripped, at most 200 characters) follows the code. |
| `WordPress HTTP 401 (…)` | Wrong username or Application Password, or a security plugin is blocking Basic auth. |
| `WordPress HTTP 403 (rest_cannot_edit_others)` | Account can't credit other authors. Use Editor/Admin or leave out `author`. |
| `WordPress HTTP 400 (rest_invalid_author)` | That author ID isn't on this site. |
| `WordPress HTTP 404 (rest_no_route)` | That route doesn't exist on this site, e.g. a plugin has disabled part of the REST API. Plain permalinks are handled automatically. |
| `WordPress HTTP 400 (term_exists)` | That category or tag already exists. Use `list_categories` / `list_tags` to get its ID. |
| `Network request failed or timed out` | For writes: **check WordPress before retrying.** |
| `WordPress HTTP <status> returned a non-JSON page` | An HTML error page, usually from a firewall, CDN (e.g. Cloudflare), hosting rule or security plugin blocking the REST API. For writes, check before retrying. |
| `WordPress returned an unreadable response (HTTP <status>)` | A success status but the body isn't JSON (something is altering responses). For writes, check before retrying. |
| `Slug already exists … at post ID N` / `… at page ID N` | Update that item, or choose a new slug. |
| `SEO fields need the MKT WP Publisher SEO Bridge plugin…` | Install the bridge on that site. Nothing was saved. |
| `… neither Yoast SEO nor Rank Math is active` | Activate one of them. Nothing was saved. |
| `… applies to posts only` / `parent applies to pages only` | Wrong field for this `post_type`. |
| `publish_date must be now or in the past` | For a future time use `schedule_post`. |
| `edit_published_post works on publish/private …` / `update_draft works on draft/pending/future …` | Use the other tool for that status. |
| `publish_at must …` | Use ISO 8601 with a timezone, between 2 minutes and 2 years ahead. |
| `… changed since you read it` | Someone edited the post in WordPress. Read it again with `get_post` and check with the user. Nothing was written. |
| `The content of X is …, but its extension says …` | The file was renamed or exported wrongly. Re-export it. Nothing was uploaded. |
| `Slug already exists … Choose another slug.` | `update_draft` was given a slug another post uses. |
| `… use the canonical HTTPS website URL …` | Fix the site URL in settings. `http://` works only for local development hosts. |
| `Request cancelled` | Check the site; an earlier step may already have been saved. |
