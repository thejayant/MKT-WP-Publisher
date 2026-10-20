# MKT WP Publisher 1.3.0 — User Guide

Developed by Jayant.

Configure up to five WordPress websites using ordinary extension fields. Each website has its own credentials and local blog image folder. No JSON is needed for new setups.

## Install and configure

Install mkt-wp-publisher-1.3.0.mcpb through Claude Desktop's extension installer. Its internal extension ID is mkt-wp-publisher, separate from Cibirix WP Publisher (local-wordpress-publisher), so both can be installed side by side with their own settings. Host-specific installation and settings appearance have not been tested here.

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

Reload/restart the extension after saving settings. Verify version 1.3.0 and fourteen tools, including list_sites, list_images, list_posts and schedule_post. Enter real passwords only in sensitive extension settings, not in chat or shared files.

## Separate blog image folders

Blog image folder means the local directory containing images to upload, not your public blog URL or permalink settings. For example:

```text
Website 1 -> C:\BlogImages\MKT
Website 2 -> C:\BlogImages\ClientTwo
Website 3 -> C:\BlogImages\ClientThree
```

Create the directories first, then select each one using its website's folder picker. Every enabled website group requires its own folder setting. Uploads use that selected website's directory and do not fall back to the old shared folder. The same filename can refer to different images in different folders. If you intentionally select the same directory for two sites, they share those files; choose different directories for separate collections.

Use filenames only, such as garage.png. Subdirectories, traversal, and external file symlinks are rejected. PNG, JPEG, and WebP are supported up to 20 MiB. Uploading an image does not insert it into article HTML; use its returned URL or attach its media ID as featured_media.

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

Claude can set a post's or page's **SEO title**, **meta description** and **focus keyword**. Neither Yoast SEO nor Rank Math lets other tools change these over the REST API, so each site needs the small companion plugin **MKT WP Publisher SEO Bridge**.

Install it once per website:

1. In WordPress admin, go to **Plugins → Add New → Upload Plugin**.
2. Upload `mkt-wp-publisher-seo-bridge.zip` and click **Activate**. It's built next to the `.mcpb` file; the source is in `wordpress-plugin/`.
3. Make sure Yoast SEO or Rank Math is active. If both are, Yoast is used.

The bridge has no settings. It only lets accounts that can edit a post change that post's SEO fields. If the bridge or an SEO plugin is missing, Claude gets a clear error and **nothing is saved**.

Example prompts:

> On website-1, update draft POST_ID with SEO title "Spring Campaign Recap | MKT", meta description "What we learned from our spring campaign." and focus keyword "spring campaign". Do not publish.

> Show me the SEO fields of draft POST_ID on website-1.

Yoast refreshes its page data when the post is next saved. Publishing (now or on schedule) is such a save, so live pages always show the new values.

## Scheduling

schedule_post sets a draft to publish automatically at a set time. Give the time **with a timezone**, or name the city or country and Claude will add it. For example, 2 November 2026 09:00 India time is sent as `2026-11-02T09:00:00+05:30`. The time must be between 2 minutes and 2 years ahead.

> Schedule draft POST_ID titled "Spring Campaign Recap" on website-1 for 2 November 2026 at 09:00 India time. I approve.

Like publishing, scheduling needs the exact title and your approval. Once scheduled, WordPress publishes the post at that time **without asking again**. Calling schedule_post again moves the time. To cancel, switch the post back to Draft in WordPress.

## Pages

Add "page" to a request to work with WordPress pages instead of posts:

> On website-1, create a draft page titled "About Us", slug about-us, under parent page 12. Do not publish.

> List the draft pages on website-1.

Pages don't have categories, tags or an excerpt, but they can have a parent page. Keep each page ID together with its site, and with the fact that it is a page.

## Writing in Markdown

Claude can send content as Markdown and the extension converts it to HTML first. Ask for it ("create the draft from this Markdown") or let Claude choose. Supported: headings, bold/italic/strikethrough, links, images, lists (including nested), quotes, code, tables and plain HTML blocks.

In the block editor the result shows as a single Classic block. Click **Convert to blocks** if you want to edit it block by block.

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

list_sites makes no network requests and returns enabled sites' IDs, names, URLs, and configured folders, plus max_sites:5. It never returns credentials. Every other tool requires site_id: test_connection, list_authors, list_categories, list_tags, list_images, list_posts, get_post, upload_image, create_term, create_draft, update_draft, publish_post, and schedule_post. list_images reads only the local folder.

Website responses use {site_id, site_url, data}. get_post returns a compact post (raw title, content, excerpt, taxonomy, dates, preview_url); pass full:true for the complete WordPress record. list_categories and list_tags return data as {items, page, total, total_pages, has_more}, 100 compact items per page (full:true for complete term objects); list_posts uses the same shape with 50 per page; when has_more is true, call again with the next page. total and total_pages come from WordPress headers and are omitted if the site does not send them. test_connection confirms authentication and reports capability flags; it does not exercise write endpoints.

## Reliability boundaries

create_draft requests draft status. update_draft allows draft/pending after a status read; featured_media:0 removes a featured image. publish_post requires confirm_publish:true, a confirm_title that matches the post's current title on that site, and explicit approval of the site and post. The title check catches a wrong post ID or wrong site_id; it does not prove a person approved. Confirmation is caller-supplied and relies on the host permission flow, not independent human verification.

publish_post refuses a draft whose date is in the future, because WordPress would schedule it rather than publish it. Change or clear the date in WordPress first. If WordPress still returns a status other than publish, the response includes a warning.

### Team rule: keep publish approval manual

In Claude Desktop, never set publish_post or schedule_post (or the extension as a whole) to always allow. The per-call approval prompt is the only real human check before a post goes live. Allowing create_term, create_draft, update_draft, upload_image, and the read tools without prompts is fine.

Tool calls run one at a time. initialize, ping, and tools/list are answered immediately, even while a slow upload is running.

Avoid concurrent editors/workers. Status reads and writes are separate, and an external editor can publish/change content between them. Duplicate checks are not atomic; there is no durable job ledger.

Cancelled queued work is skipped. Active requests receive an abort signal and later steps stop once cancellation is observed. Cancellation cannot undo a committed WordPress write. Each HTTP request, including response reading, has a 60-second timeout; a multi-step tool can take longer overall.

After a timeout, cancellation, or unreadable write response, inspect the selected website before retrying. Uploads can remain if later steps fail. Errors include site/media IDs when available; metadata repair still requires WordPress admin.

The extension uses local stdio and outbound HTTPS with redirect rejection. No network listener, tunnel, AI API key, or npm runtime dependency is needed. The host handles sensitive password storage; credentials reach the local process through environment variables. The computer must be awake for calls.

Custom post types, image generation, custom fields other than SEO, unscheduling and deletion tools are not included. Categories and tags can be created with create_term.

## Validation and troubleshooting

Run npm test from the unpacked source. Mocked tests cover routing, credentials, five-site limits, enabled/disabled groups, required folders, duplicate IDs/slugs, different image contents with identical filenames, cross-folder exclusion, cancellation, and startup. Symlink tests explicitly skip when the host denies symlink creation; traversal tests still run.

Locally tested on Node v22.22.0 / Windows. Claude Desktop installation/settings rendering, live website permissions, and other platforms remain unverified. No actual WordPress requests or website writes were made during development.

No tools: reload the extension and inspect developer logs. Missing site_id: list_sites first. Unset optional settings that reach the server as literal ${user_config.…} placeholders are treated as empty. Missing image: verify the selected site's folder and filename. HTTP 401/403: check that site's credentials, role, and security rules. Redirect failure: configure its canonical HTTPS installation URL without /wp-admin or /wp-json.
