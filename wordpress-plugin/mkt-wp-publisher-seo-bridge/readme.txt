=== MKT Publisher SEO Bridge for Yoast & Rank Math ===
Contributors: jayant
Tags: seo, yoast, rank math, rest api, claude
Requires at least: 5.6
Requires PHP: 7.4
Stable tag: 1.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Lets the MKT WP Publisher extension for Claude read and update SEO titles, meta descriptions, focus keywords and canonical URLs in Yoast SEO or Rank Math.

== Description ==

Yoast SEO and Rank Math keep their SEO fields out of the WordPress REST API, so other tools cannot set them. This plugin adds one REST field, `mkt_seo`, to posts and pages, so the MKT WP Publisher extension for Claude Desktop can:

* set the SEO title, meta description, focus keyword and canonical URL when it creates a draft;
* change them on drafts, scheduled posts and published posts;
* read them back for review.

There are no settings. A status page under **Tools → MKT SEO Bridge** shows the detected SEO plugin and the fields the extension can update.

Security:

* Only accounts that can edit a post can read or change its SEO fields.
* Values are stored as plain text; canonical URLs must be http or https links.
* Every value has a maximum length.
* The plugin never contacts any external service.

== Installation ==

1. In WordPress admin go to **Plugins → Add New → Upload Plugin**.
2. Upload `mkt-wp-publisher-seo-bridge.zip` and click **Activate**.
3. Make sure Yoast SEO or Rank Math is active. If both are, Yoast SEO is used.
4. Open **Tools → MKT SEO Bridge** to check the status.

To update, upload the new zip the same way and choose **Replace current with uploaded**.

== Frequently Asked Questions ==

= Why do changes show up on the live page straight away with Yoast SEO? =

For existing posts the bridge saves the SEO values just before WordPress saves the post, so Yoast SEO rebuilds its cached page data with the new values.

= What happens if I deactivate the plugin? =

The extension can no longer change SEO fields; anything already saved stays in Yoast SEO or Rank Math as normal.

== Changelog ==

= 1.1.0 =
* New name: MKT Publisher SEO Bridge for Yoast & Rank Math. New icon.
* Fix: on existing posts, SEO values are saved before the post itself, so Yoast SEO shows edited titles and descriptions on the live page right away (previously only after the next save).
* New: canonical URL field (Yoast SEO and Rank Math).
* New: maximum lengths, checked before anything is saved.
* New: Tools → MKT SEO Bridge status page, and a Status link on the Plugins screen.
* The REST field reports the bridge version.
* "Update URI: false", so WordPress never offers an unrelated wordpress.org plugin as an update.

= 1.0.0 =
* First release: SEO title, meta description and focus keyword for posts and pages.
