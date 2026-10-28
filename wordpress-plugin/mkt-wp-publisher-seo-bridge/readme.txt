=== MKT Publisher SEO Bridge for Yoast & Rank Math ===
Contributors: jayant
Tags: seo, yoast, rank math, aioseo, seopress
Requires at least: 5.6
Requires PHP: 7.4
Stable tag: 1.4.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Lets WP Publisher (for Claude and for ChatGPT) read and update SEO titles, meta descriptions, focus keywords and canonical URLs in Yoast SEO, Rank Math, All in One SEO or SEOPress.

== Description ==

Yoast SEO and Rank Math keep their SEO fields out of the WordPress REST API, so other tools cannot set them. This plugin adds one REST field, `mkt_seo`, to posts and pages, so the MKT WP Publisher extension for Claude Desktop can:

* set the SEO title, meta description, focus keyword and canonical URL when it creates a draft;
* change them on drafts, scheduled posts and published posts;
* read them back for review.

From version 1.3.0 it also adds a REST field, `mkt_fields`, so the extension can read and change **custom fields**. These are the Advanced Custom Fields shown on a post, page, product or category, including single rows inside repeaters and flexible content. Each value is checked against the field settings before it is saved. The field is only computed for requests that ask for it, so the editor and other plugins are not slowed down.

A status page under **Tools → MKT SEO Bridge** shows the detected SEO plugin, Advanced Custom Fields, and the fields the extension can update. Its only setting is an optional list of meta keys, for custom fields that are not made with Advanced Custom Fields.

Security:

* Only accounts that can edit a post can read or change its SEO fields.
* Values are stored as plain text; canonical URLs must be http or https links.
* Every value has a maximum length.
* The plugin never contacts any external service.

Compatibility with other plugins and custom sites:

* Everything lives in one class; a second copy of the plugin (an old folder, or a must-use copy) does nothing instead of causing a fatal error.
* It only acts on REST requests that contain its own `mkt_seo` field. Saves from the block editor, Classic editor, page builders and other plugins are untouched.
* Clients that send back a whole post they read (headless sites, sync tools) are never rejected because of this field: read-only parts and empty values are ignored.
* Errors inside the plugin are caught, so it cannot break other REST responses or the editor.
* Rank Math is detected without running other plugins' autoloaders.
* Sites that removed posts or pages are handled.
* Tested on PHP 7.4, 8.1 and 8.5 with a WordPress stand-in harness; please also test on a staging copy of your site.

== Installation ==

1. In WordPress admin go to **Plugins → Add New → Upload Plugin**.
2. Upload `mkt-wp-publisher-seo-bridge.zip` and click **Activate**.
3. Make sure Yoast SEO, Rank Math, All in One SEO or SEOPress is active. If more than one is, the first in that order is used.
4. Open **Tools → MKT SEO Bridge** to check the status.

To update, upload the new zip the same way and choose **Replace current with uploaded**.

== Frequently Asked Questions ==

= Why do changes show up on the live page straight away with Yoast SEO? =

For existing posts the bridge saves the SEO values just before WordPress saves the post, so Yoast SEO rebuilds its cached page data with the new values.

= What happens if I deactivate the plugin? =

The extension can no longer change SEO fields; anything already saved stays in Yoast SEO or Rank Math as normal.

== Changelog ==

= 1.4.0 =
* New: All in One SEO (posts, pages and other post types; its category and tag SEO is a Pro feature and is not written) and SEOPress (posts and terms). Yoast SEO, then Rank Math, then All in One SEO, then SEOPress is used when more than one is active, so existing sites behave exactly as before.
* New: read-only `mkt_builder` REST field naming the page builder (Elementor, Bricks, Beaver Builder, Breakdance, Oxygen, Divi, WPBakery, Avada) that owns a post's layout, so WP Publisher does not overwrite builder pages.
* Older WP Publisher versions keep working with this version unchanged.

= 1.3.0 =
* New: custom fields. The `mkt_fields` REST field reads and writes Advanced Custom Fields (free or Pro) on posts, pages, products, categories and tags, including repeaters, groups and flexible content.
* Every value is checked against its field settings before saving. Unknown and read-only fields are refused, and if any change fails, nothing is saved.
* Optional list of editable meta keys (Tools → MKT SEO Bridge) for custom fields that are not made with ACF. WordPress internal keys are never editable.
* Only computed for requests that ask for it.

= 1.2.2 =
* Fix: SEO fields on tags. WordPress looks up extra REST fields for tags under the name "tag", not "post_tag".

= 1.2.1 =
* Taxonomies are chosen by show_ui + show_in_rest instead of public. (This did not fix tags; see 1.2.2.)

= 1.2.0 =
* SEO fields on every public post type (products, custom post types) and on categories, tags and product categories, for Yoast SEO and Rank Math.

= 1.1.0 =
* New name: MKT Publisher SEO Bridge for Yoast & Rank Math. New icon.
* Fix: on existing posts, SEO values are saved before the post itself, so Yoast SEO shows edited titles and descriptions on the live page right away (previously only after the next save).
* New: canonical URL field (Yoast SEO and Rank Math).
* New: maximum lengths, checked before anything is saved.
* New: Tools → MKT SEO Bridge status page, and a Status link on the Plugins screen.
* The REST field reports the bridge version.
* "Update URI: false", so WordPress never offers an unrelated wordpress.org plugin as an update.
* Conflict hardening: guarded class (no "Cannot redeclare" fatal if loaded twice), no global variables, autoloader-safe detection, lenient handling of echoed-back or null values, other plugins' errors passed through, errors inside callbacks caught.

= 1.0.0 =
* First release: SEO title, meta description and focus keyword for posts and pages.
