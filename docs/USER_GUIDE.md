# MKT WP Publisher 1.7.0 — User Guide

Developed by Jayant.

Configure up to five WordPress websites using ordinary extension fields. Each website has its own credentials and local blog image folder. No JSON is needed for new setups.

## Install and configure

Install mkt-wp-publisher-1.7.0.mcpb through Claude Desktop's extension installer. Its internal extension ID is mkt-wp-publisher, separate from Cibirix WP Publisher (local-wordpress-publisher), so both can be installed side by side with their own settings. Host-specific installation and settings appearance have not been tested here.

Open the extension settings and fill the labeled Website 1 group:

| Setting | What to enter |
| --- | --- |
| Enable website 1 | Turn this on to use the website |
| Website 1: Website name | A friendly name, for example MKT Blog |
| Website 1: WordPress URL | Canonical HTTPS WordPress installation URL, such as https://example.com |
| Website 1: WordPress username | The WordPress account for this website |
| Website 1: Application Password | An Application Password generated on this website |
| Website 1: Blog image folder | Pick the local folder containing this website's blog images |

To add another website, fill and enable Website 2. Repeat for Website 3, 4, and 5 as needed. Leave unused groups disabled. To remove a site from tool discovery, disable its group; to remove saved credentials as well, clear its fields.

These are labeled field groups in the native settings, not custom collapsible panels. All five groups may be visible. The documented MCPB settings format supports fields, checkboxes, and folder pickers; it does not provide a dynamic Add Website button or conditional section rendering. The host controls their presentation. [MCPB settings specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md).

Reload/restart the extension after saving settings. Verify version 1.7.0 and 23 tools, including list_sites, list_images, list_posts and schedule_post. Enter real passwords only in sensitive extension settings, not in chat or shared files.

## Separate blog image folders

Blog image folder means the local directory containing images to upload, not your public blog URL or permalink settings. For example:

```text
Website 1 -> C:\BlogImages\MKT
Website 2 -> C:\BlogImages\ClientTwo
Website 3 -> C:\BlogImages\ClientThree
```

Create the directories first, then select each one using its website's folder picker. Every enabled website group requires its own folder setting. Uploads use that selected website's directory and do not fall back to the old shared folder. The same filename can refer to different images in different folders. If you intentionally select the same directory for two sites, they share those files; choose different directories for separate collections.

Use filenames only, such as garage.png. Subdirectories, traversal, and external file symlinks are rejected. PNG, JPEG, WebP, GIF and AVIF are supported up to 20 MiB (AVIF needs WordPress 6.5 or later). The file content must match its extension, so a JPEG renamed to .png is refused; list_images flags such files. Uploading returns a ready-to-paste html figure for the article, and featured_for_post_id sets the image as a draft's featured image in the same step:

> Upload hero.png from website-1's image folder with alt text "Team at the spring launch" and make it the featured image of draft POST_ID. Do not publish.

## Publishing as different authors

Each website connects with one WordPress account, but each post can be credited to a different person on that website.

1. Ask Claude to list the authors on the website. list_authors returns each person's author_id, name and slug (never email addresses).
2. When creating or updating a draft, name the author. Claude passes their author_id as author.
3. Leave the author out and a new draft is credited to the connected account; an updated draft keeps its current author.

Example prompts:

> List the authors on website-1.

> On website-1, create a draft titled Spring Campaign Recap, slug spring-campaign-recap, content <p>Draft text.</p>, with Priya Sharma as the author. Do not publish.

> Change the author of draft POST_ID on website-1 to Rahul Mehta. Do not publish.

Requirements:

- To credit a post to someone else, the website must be connected with an **Editor or Administrator** account. Author and Contributor accounts can only post as themselves; WordPress refuses the request and nothing is created. test_connection shows edit_others_posts: true when the account is allowed.
- The person must already be a user on that website with permission to write posts. Author IDs belong to one website; look them up separately for each site.
- One author per post, as in standard WordPress. Co-author plugins are not supported.

## SEO fields (Yoast SEO / Rank Math)

Claude can set a post's or page's **SEO title**, **meta description**, **focus keyword** and **canonical URL**. Neither Yoast SEO nor Rank Math lets other tools change these over the REST API, so each site needs the small companion plugin **MKT Publisher SEO Bridge for Yoast & Rank Math** (bridge version 1.1.0).

Install it once per website, or update it:

1. In WordPress admin, go to **Plugins → Add New → Upload Plugin**.
2. Upload `mkt-wp-publisher-seo-bridge.zip` and click **Install Now**. It's built next to the `.mcpb` file; the source is in `wordpress-plugin/`. When updating from 1.0.0, WordPress asks whether to replace the installed version: choose **Replace current with uploaded**.
3. Click **Activate** (new installs only), and make sure Yoast SEO or Rank Math is active. If both are, Yoast is used.
4. Open **Tools → MKT SEO Bridge**, or the **Status** link under the plugin on the Plugins screen. It shows the icon, the bridge version, the detected SEO plugin, whether Application Passwords are allowed, and which fields the extension can update.

The bridge has no settings. It only lets accounts that can edit a post change that post's SEO fields. Values have maximum lengths (title 300, description 1,000, focus keyword 200, canonical 2,048 characters), and canonical URLs must be `http://` or `https://` links. If the bridge or an SEO plugin is missing, or the bridge is too old for a field (canonical needs 1.1.0), Claude gets a clear error and **nothing is saved**.

On a published post, edited SEO values show up on the live page right away. The bridge saves them just before WordPress saves the post, so Yoast rebuilds its page data with the new values. Bridge 1.0.0 only showed them after the next save.

Example prompts:

> On website-1, update draft POST_ID with SEO title "Spring Campaign Recap | MKT", meta description "What we learned from our spring campaign." and focus keyword "spring campaign". Do not publish.

> Show me the SEO fields of draft POST_ID on website-1.

Yoast refreshes its page data when the post is next saved. Publishing (now or on schedule) is such a save, so live pages always show the new values.

## Scheduling

schedule_post sets a draft to publish automatically at a set time. Give the time **with a timezone**, or name the city or country and Claude will add it. For example, 2 November 2026 09:00 India time is sent as `2026-11-02T09:00:00+05:30`. The time must be between 2 minutes and 2 years ahead.

> Schedule draft POST_ID titled "Spring Campaign Recap" on website-1 for 2 November 2026 at 09:00 India time. I approve.

Like publishing, scheduling needs the exact title and your approval. Once scheduled, WordPress publishes the post at that time **without asking again**. Calling schedule_post again moves the time.

You can still edit a scheduled post with update_draft (text, images, SEO fields, categories); it keeps its publish time. To cancel the schedule, use unpublish_post, which turns it back into a draft:

> On website-1, change the featured image of scheduled post POST_ID to launch-v2.png. Keep its schedule.

> Unschedule post POST_ID titled "Spring Campaign Recap" on website-1 and keep it as a draft. I approve.

## Back-dating

To publish a post with an earlier date (for example, moving an old article over), give publish_post a past date and time with a timezone:

> Publish draft POST_ID titled "Our 2024 Results" on website-1 with the date 15 March 2025, 10:00 India time. I approve publication.

The date must be now or in the past; for a future time, use scheduling. A draft that already carries a future date can be published right now the same way, by giving the current time.

## Editing published posts

edit_published_post changes a post that is already live: content, title, featured image, categories, tags, author, SEO title, meta description and focus keyword, slug, or its date. Changes are visible immediately, so it needs your approval and the post's **current** title (Claude reads it first with get_post):

> On website-1, for the published post POST_ID titled "Spring Campaign Recap": set the meta title to "Spring Recap 2026 | MKT", the meta description to "Highlights and numbers from our spring campaign.", and use hero-v2.png from the image folder as the featured image. I approve editing the live post.

To swap an image, Claude uploads the new file with upload_image and then points the post at it. Changing the slug changes the post's public address, so old links may break unless your site redirects them. Claude warns you when that happens.

To take a live post offline, use unpublish_post. It becomes a draft again, which you can edit and publish later:

> Unpublish post POST_ID titled "Spring Campaign Recap" on website-1. I approve.

## Pages

Add "page" to a request to work with WordPress pages instead of posts:

> On website-1, create a draft page titled "About Us", slug about-us, under parent page 12. Do not publish.

> List the draft pages on website-1.

Pages don't have categories, tags or an excerpt, but they can have a parent page. Keep each page ID together with its site, and with the fact that it is a page.

## Writing in Markdown

Claude can send content as Markdown and the extension converts it to HTML first. Ask for it ("create the draft from this Markdown") or let Claude choose. Supported: headings, bold/italic/strikethrough, links, images, lists (including nested), quotes, code, tables and plain HTML blocks.

In the block editor the result shows as a single Classic block. Click **Convert to blocks** if you want to edit it block by block.

## Editing block-built pages safely

Pages built with the block editor (headings, columns, ACF blocks) must not be replaced wholesale, or their layout is lost. Ask Claude to change specific text, and it will use list_blocks and edit_blocks:

> On website-1, in the Florida page (ID 1941), change "all 67 Florida counties" to "every county in Florida". Show me the change first. I approve editing the live page.

Claude reads the page's blocks, changes only that text, checks the block structure is unchanged, and shows a before/after diff. Text inside ACF blocks (for example an FAQ question) is changed by field name. If the text appears more than once, Claude asks which occurrence you mean. To undo, open the page in WordPress, then **Revisions**.

## Products and other post types

The post tools also work for WooCommerce products and custom post types (for example `locations`). Name the type in your request:

> On website-1, show product 9329 and its price.

> Set the sale price of product 9329 ("26x35x10 Triple Wide Carport") to 8995. I approve this store change.

> Update the SEO title of product 9329 to "Triple Wide Carport 26x35 | AMB". I approve editing the live product.

Prices, SKU, stock, short description, product categories and gallery go through WooCommerce (update_product). The long description, title, slug and SEO go through the normal post tools with post type `product`. The connected account needs the Shop Manager or Administrator role. New products are created in WordPress itself, so price and stock are set up properly.

## Categories, tags and product categories

> List the product categories on website-1.

> Change the description of product category "Metal Carports" to "…" and its SEO title to "Metal Carports for Sale | AMB". I approve.

Claude confirms the category's current name before saving. Category SEO needs SEO Bridge 1.2.0 or later on the site. With Yoast, only the SEO title, description, focus keyword and canonical are changed; the category's other Yoast settings stay as they are.

## Website IDs and prompts

Website groups have stable IDs independent of their friendly names: website-1, website-2, website-3, website-4, and website-5.

Start with:

> Use MKT WP Publisher to list my enabled websites and their blog image folders. Do not create or publish anything.

Then:

> Test website-1 and website-2. Show their destination URLs and reported capabilities. Do not publish anything.

See which images are available:

> List the images in website-2's blog image folder.

Find an existing draft:

> Find my drafts on website-2 that mention "garage".

Create a tag if it is missing:

> On website-2, create the tag "Home Automation" if it doesn't exist and give me its ID.

Upload:

> Upload garage.png from website-2's blog image folder to website-2 with alt text describing the garage. Return site_id, media_id, and image URL.

Create a draft:

> On website-2, create a draft titled Automation Connection Test, slug automation-connection-test, content <p>This is a test draft.</p>. Do not publish. Return its site ID and post ID.

Attach an image:

> Update draft POST_ID on website-2 with featured_media MEDIA_ID returned for website-2. Do not publish.

Review the draft in WordPress (draft summaries include a preview_url; open it while logged in), then:

> Publish the reviewed draft POST_ID titled "Automation Connection Test" on website-2. I approve publication on that website.

publish_post requires the post's current title as confirm_title. If the title does not match what is on that website, nothing is published.

Keep post, category, tag, and media IDs paired with their site_id. Identical numeric IDs can refer to unrelated objects on different sites. If you reconfigure a group to point at a different website, discard its old IDs and rediscover resources for the new destination.

## Upgrade from earlier versions

Previous JSON and single-site settings remain under Advanced / previous setup. To move to simple fields, enter each old site's URL, username, password, and folder into a Website 1-5 group and enable it. Old settings are not copied automatically.

Configuration precedence:

1. Enabled groups replace the previous configuration entirely. Disabled groups are ignored, including incomplete ones.
2. If groups contain details but all are disabled, the server stops with an explicit error instead of routing to an older website.
3. If all groups are empty and disabled, previous JSON profiles are used, if populated. The five-site maximum also applies here. Old custom IDs are preserved. Advanced profiles can add image_folder per site; old profiles without it retain the previous shared-folder fallback for migration.
4. Otherwise complete previous single-site settings appear as site_id default.

New groups always require their own folder. To return to old settings after disabling all filled groups, clear the groups first. Keep previous bundles for rollback.

## Tools and responses

list_sites makes no network requests and returns enabled sites' IDs, names, URLs, and configured folders, plus max_sites:5. It never returns credentials. Every other tool requires site_id: test_connection, list_authors, list_categories, list_tags, list_images, list_posts, get_post, upload_image, create_term, create_draft, update_draft, edit_published_post, publish_post, unpublish_post, and schedule_post. list_images reads only the local folder.

Website responses use {site_id, site_url, data}. get_post returns a compact post (raw title, content, excerpt, taxonomy, dates, preview_url); pass full:true for the complete WordPress record. list_categories and list_tags return data as {items, page, total, total_pages, has_more}, 100 compact items per page (full:true for complete term objects); list_posts uses the same shape with 50 per page; when has_more is true, call again with the next page. total and total_pages come from WordPress headers and are omitted if the site does not send them. test_connection confirms authentication and reports capability flags; it does not exercise write endpoints.

## Reliability boundaries

create_draft requests draft status. update_draft allows draft/pending after a status read; featured_media:0 removes a featured image. publish_post requires confirm_publish:true, a confirm_title that matches the post's current title on that site, and explicit approval of the site and post. The title check catches a wrong post ID or wrong site_id; it does not prove a person approved. Confirmation is caller-supplied and relies on the host permission flow, not independent human verification.

publish_post refuses a draft whose date is in the future, because WordPress would schedule it rather than publish it. Change or clear the date in WordPress first. If WordPress still returns a status other than publish, the response includes a warning.

### Team rule: keep publish approval manual

In Claude Desktop, never set publish_post, schedule_post, edit_published_post or unpublish_post (or the extension as a whole) to always allow. The per-call approval prompt is the only real human check before public content changes. Allowing create_term, create_draft, update_draft, upload_image, and the read tools without prompts is fine.

Calls to the same website run one at a time; different websites are handled in parallel, so a slow upload to one site does not hold up another. initialize, ping, and tools/list are answered immediately.

Avoid concurrent editors/workers. Status reads and writes are separate, and an external editor can publish/change content between them. To guard against that, Claude can pass expected_modified_gmt (from get_post) to update_draft, publish_post and schedule_post; if the post changed in WordPress since it was read, nothing is written. Duplicate checks are not atomic; there is no durable job ledger.

Cancelled queued work is skipped. Active requests receive an abort signal and later steps stop once cancellation is observed. Cancellation cannot undo a committed WordPress write. Each HTTP request, including response reading, has a 60-second timeout (180 seconds for image uploads); a multi-step tool can take longer overall. Reads that hit a busy server (HTTP 429, 502, 503, 504) are retried up to twice; writes are never retried automatically.

After a timeout, cancellation, or unreadable write response, inspect the selected website before retrying. Uploads can remain if later steps fail. Errors include site/media IDs when available; metadata repair still requires WordPress admin.

The extension uses local stdio and outbound HTTPS with redirect rejection (plain http only for local development sites such as localhost, *.local or *.test). No network listener, tunnel, AI API key, or npm runtime dependency is needed. The host handles sensitive password storage; credentials reach the local process through environment variables. The computer must be awake for calls.

Custom post types, image generation or resizing, uploads from a URL, custom fields other than SEO, and deletion tools are not included. Categories and tags can be created with create_term.

## Validation and troubleshooting

Run npm test from the source folder. Mocked tests cover routing, credentials, five-site limits, enabled/disabled groups, required folders, duplicate IDs/slugs, image content checks, cross-folder exclusion, retries, cancellation, and startup. Symlink tests explicitly skip when the host denies symlink creation; traversal tests still run. npm run test:live runs an optional round trip against a staging site (see docs/DEVELOPMENT.md).

Locally tested on Node v25.1.0 / Windows. Claude Desktop installation/settings rendering, live website permissions, and other platforms remain unverified. No actual WordPress requests or website writes were made during development.

Debug log: turn on Advanced | Debug log in the extension settings, restart the extension, and repeat the failing request. Each WordPress request then adds one line (site, method, path, HTTP status, time) to the extension's log in Claude Desktop's developer settings. Passwords, search text and content are never logged. Turn it off again afterwards.

Certificate errors (for example CERT_HAS_EXPIRED) on a site that opens fine in the browser: since 1.5.0 the extension trusts Node's built-in certificate list as well as Windows', so an outdated certificate in the Windows store (such as the expired ISRG Root X2 cross-certificate that broke mktwptest.wasmer.app) no longer blocks the connection. If you still see one, make sure 1.5.0 or later is installed and fully restart Claude Desktop; the error text names the Node version in use.

No tools: reload the extension and inspect developer logs. Missing site_id: list_sites first. Unset optional settings that reach the server as literal ${user_config.…} placeholders are treated as empty. Missing image: verify the selected site's folder and filename. HTTP 401/403: check that site's credentials, role, and security rules. Redirect failure: configure its canonical HTTPS installation URL without /wp-admin or /wp-json. Local development site: http:// is accepted for localhost, *.local, *.test and *.localhost addresses only.
