# MKT WP Publisher

**Version 1.6.0 · Developed by Jayant**

A Claude Desktop extension that lets Claude draft, schedule, publish and edit blog posts and pages on **up to five WordPress websites**. Each website has its own login (WordPress Application Password) and its own local blog image folder. Content is always created as a draft first. Publishing, scheduling, editing a live post and unpublishing each need your explicit approval.

## What it can do

| Tool | What it does |
| --- | --- |
| `list_sites` | Lists your enabled websites (IDs, names, URLs, image folders). No passwords. No network calls. |
| `test_connection` | Checks the login and shows what the account is allowed to do. |
| `list_authors` | Lists people who can be credited as an author. |
| `list_categories` / `list_tags` | Lists existing categories and tags (100 per page). |
| `list_images` | Lists the images in that website's blog image folder and flags any that can't be uploaded. No network calls. |
| `list_posts` | Finds drafts (or any posts or pages) by search text and status. |
| `get_post` | Reads a post or page so it can be reviewed, including its SEO fields. |
| `upload_image` | Uploads a PNG, JPG, WebP, GIF or AVIF from that website's image folder (content is checked first), returns ready-to-paste HTML, and can set it as a draft's featured image. |
| `create_term` | Creates a category or tag, reusing an existing one with the same name. |
| `create_draft` | Creates a draft post or page: title, content (HTML or Markdown), slug, excerpt, categories, tags, featured image, author, SEO fields. |
| `update_draft` | Changes a draft, pending or scheduled post or page (a scheduled post keeps its time). |
| `edit_published_post` | Changes a live post or page (content, images, SEO title and description, slug, date), only with approval and the exact current title. |
| `publish_post` | Publishes a draft now, or with a back date, only with approval and the exact title. |
| `unpublish_post` | Moves a published or scheduled post back to draft (also unschedules), only with approval and the exact title. |
| `schedule_post` | Schedules a draft for a set date and time, only with approval and the exact title. |

Every draft comes with a `preview_url` for review. Reads are retried automatically when a busy host answers "try again later". An optional `expected_modified_gmt` check stops Claude from overwriting changes someone else made in WordPress in the meantime.

**SEO fields** (Yoast SEO or Rank Math: SEO title, meta description, focus keyword, canonical URL) need the small companion plugin **MKT Publisher SEO Bridge for Yoast & Rank Math** installed on each site. See [the user guide](docs/USER_GUIDE.md#seo-fields-yoast-seo--rank-math).

Not included: custom post types, deleting content, uploading images from a URL. See [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md).

## Quick start

1. **Create an Application Password** in each WordPress site: *Users → Profile → Application Passwords*. Use an **Editor or Administrator** account if you want to credit posts to other authors.
2. **Install** `mkt-wp-publisher-1.6.0.mcpb` from Claude Desktop's extension settings.
3. **Fill in Website 1**: name, HTTPS URL (for example `https://example.com`), username, Application Password and blog image folder. Turn on **Enable website 1**. Repeat for Websites 2–5 if you need them.
4. *(Optional, for SEO fields)* Upload `mkt-wp-publisher-seo-bridge.zip` in each WordPress site under *Plugins → Add New → Upload Plugin*, then activate it.
5. **Restart the extension**, then ask Claude:

   > Use MKT WP Publisher to list my enabled websites, then test website-1. Do not create or publish anything.

6. **Create a draft:**

   > On website-1, create a draft from this Markdown, titled "Spring Campaign Recap", slug spring-campaign-recap, with Priya Sharma as author, SEO title "Spring Campaign Recap | MKT" and focus keyword "spring campaign". Use hero.png from the image folder as its featured image. Do not publish.

7. Review it with the preview link, then:

   > Publish the reviewed draft POST_ID titled "Spring Campaign Recap" on website-1. I approve publication.

   or

   > Schedule draft POST_ID titled "Spring Campaign Recap" on website-1 for 2 November 2026 at 09:00 India time. I approve.

   Later changes to the live post:

   > On website-1, change the featured image of published post POST_ID titled "Spring Campaign Recap" to hero-v2.png and set its meta description to "…". I approve editing the live post.

> **Team rule:** never set `publish_post`, `schedule_post`, `edit_published_post` or `unpublish_post` to "Always allow" in Claude Desktop. The approval prompt is the only real human check before public content changes.

## Requirements

- Claude Desktop with extension (MCPB) support
- Node.js 18 or later (the version bundled with Claude Desktop works)
- WordPress 5.6+ with the REST API reachable and Application Passwords allowed (some security plugins block them). Plain permalinks are detected automatically. AVIF uploads need WordPress 6.5+.
- Sites must use HTTPS. Plain `http://` works only for local development sites (localhost, `*.local`, `*.test`, `*.localhost`).
- For SEO fields: Yoast SEO or Rank Math, plus the SEO Bridge plugin (PHP 7.4+)

## Documentation

| Document | For |
| --- | --- |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Full setup, image folders, authors, SEO, scheduling, pages, example prompts, upgrading, troubleshooting |
| [docs/TOOLS_REFERENCE.md](docs/TOOLS_REFERENCE.md) | Every tool's arguments, responses and errors |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the server works inside, plus the security model |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Tests, lint, packaging, live testing, CI, release checklist |
| [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md) | Backlog status and what is still open |
| [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) | Short overview for developers and AI assistants |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Development

No npm dependencies. Node 18+ is all you need.

| Command | What it does |
| --- | --- |
| `npm test` | Runs the mocked test suite (no real WordPress requests) |
| `npm run lint` | Syntax and consistency checks (versions, tool lists, settings) |
| `npm run pack` | Lint and tests, then builds the `.mcpb` and the SEO Bridge zip into the parent folder |
| `npm run test:live` | Optional round trip against a **staging** site (see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)) |

The server code is in [server/](server/), with [server/service.js](server/service.js) as the entry module. The WordPress companion plugin is in [wordpress-plugin/](wordpress-plugin/). CI runs on GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

## License

MIT. See [LICENSE](LICENSE). The WordPress plugin in `wordpress-plugin/` is GPL-2.0-or-later, as WordPress plugins usually are.
