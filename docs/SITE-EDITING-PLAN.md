# Site editing plan: categories, products, states, cities and custom-template pages

_Audit date: 2026-10-21. Sites: directmetalstructures.com, americanmetalbuildings.com, aametalbuildings.com, qualitysteelbuildings.com, safewaysteel.com. Read-only, from public pages and the public REST API; nothing was changed._

Each section below says **what WordPress stores and where** (verified unless marked *to confirm*), **the exact tool calls** the extension will make, **an example on your real pages**, and **the safety rules**.

## Status

| Step | Status |
| --- | --- |
| 1. Block-safe edits | Built in 1.7.0 (`list_blocks`, `edit_blocks`) |
| 2. Products and custom post types | Built in 1.7.0 (`post_type` for any REST type, `get_product`, `update_product`) |
| 3. Categories | Built in 1.7.0 (`list_terms`, `get_term`, `update_term`) with SEO Bridge 1.2.0 |
| 4. Custom fields | Built in 1.8.0 (`inspect_fields`, `update_fields`) with SEO Bridge 1.3.0 (option B, `mkt_fields`) |

---

## 0. What the audit verified

| Fact | Evidence |
| --- | --- |
| All five sites are WordPress; four run WooCommerce (not Safeway) | `/wp-json/` namespaces include `wc/v3` on DMS, AMB, AAMB, QSB |
| SEO plugin: DMS = Rank Math, the other four = Yoast | Page `<head>` markers; `rankmath/v1` and `yoast/v1` namespaces |
| Categories and sub-categories are WooCommerce **product categories** (`product_cat` terms), except AAMB "Metal Building Prices", which is a **page** | Body classes `tax-product_cat term-N`; `/wp/v2/product_cat/N` returns 200 |
| Products are the WooCommerce `product` post type | `single-product postid-N`; `/wp/v2/product/N` returns 200 |
| QSB states are a **custom post type `locations`** (made with CPT UI) | `single-locations`; `/wp/v2/locations/590`; `cptui/v1` namespace |
| AMB, AAMB and Safeway use **ACF Pro** (6.8.10, 6.8.10, 6.3.5) | Plugin readme files are public |
| AMB/AAMB: ACF's REST API is on, but the field groups are **not shown in REST** | `"acf": []` on `/wp/v2/pages/2803`, `/wp/v2/product/9329`, `/wp/v2/product_cat/16` |
| Safeway: field `full_page_content` **is** shown in REST. It is flexible content: layout `2_column_content` → rows of `{2_column_content_text (HTML), 2_column_content_image (media ID)}` | `/wp/v2/pages/2549` → `acf.full_page_content` |
| On custom-template pages, most visible text is **not** in the page content | Visible words vs `content.rendered`: AMB state 3% of 5,545 words, AAMB city 0%, QSB financing 0%, Safeway 0–21% |
| DMS state pages: about 100% of visible text is in the page content, as normal blocks plus **10 ACF blocks** (their text is in block attributes inside the content) | `content.rendered` of page 1941; `acf-block` markers |
| WooCommerce REST API exists and requires login | `GET /wc/v3/products/9329` → 401 `woocommerce_rest_cannot_view` |
| Yoast category SEO is set on AMB (custom title/description) | `/wp/v2/product_cat/16` → `yoast_head_json.title` = "Metal Carports - Durable & Custom Steel Carports for Sale…" |
| *To confirm:* where QSB's and DMS's custom fields come from | No ACF/Meta Box/Pods readme found publicly. DMS posts carry `_acf_changed` meta, so ACF is probably installed under another folder or bundled with the theme. Path 4's `inspect_fields` tool answers this in one call. |

---

## Path 1: Block-safe content edits (DMS state pages, About Us; any block-built page)

**Problem:** `update_draft` / `edit_published_post` replace the **whole** `content`. On block-built pages, any text Claude sends without the exact block comments (`<!-- wp:paragraph -->`, `<!-- wp:acf/... {"data":{…}} /-->`) would flatten the layout and wipe the ACF blocks.

**How it works:**

1. Read the raw content (logged in): `GET /wp/v2/pages/1941?context=edit` → `content.raw`, the exact stored text including block comments.
2. Parse it into blocks with WordPress's block grammar. Each block keeps its exact original bytes, so unchanged blocks are written back byte-for-byte.
3. New tool **`list_blocks(site_id, post_id)`** returns a numbered outline, e.g.:
   `#0 core/heading "Metal Buildings Florida" · #1 core/paragraph "Direct Metal Structures supplies…" · #4 acf/faq data.question_1 "…"`
4. New tool **`edit_blocks(site_id, post_id, changes[], confirm_title, expected_modified_gmt)`**. Each change is one of:
   - `{block: 1, replace_text: {find: "all 67 Florida counties", with: "every Florida county"}}`: text inside one block only.
   - `{block: 4, acf_data: {question_1: "…"}}`: one field inside an ACF block's `data`.
   - `{find: "...", with: "...", all: false}`: page-wide exact-text replace, refused if the text matches more than once (unless `all: true`).
5. Before saving, the tool re-parses the result and checks that the block structure (count, order, names) is identical, and that only the targeted text changed. Otherwise nothing is written.
6. It returns a **before/after diff**. WordPress keeps a revision of every save (pages support revisions), so any edit can be restored from *Revisions* in the editor.
7. Published pages go through the same approval rule as `edit_published_post`: the current title must be confirmed.

**Example (DMS Florida, page 1941):** *"In the Florida page, change 'all 67 Florida counties' to 'every county in Florida'."* → `list_blocks` → `edit_blocks` with one `replace_text` → diff shown → saved. Other blocks are untouched.

**Needs on the sites:** nothing. **Extension work:** block parser, two tools, tests. **Covers:** DMS states and About Us now; any block-built page on all sites.

---

## Path 2: Products and custom post types (all WooCommerce sites; QSB locations)

**How it works:**

- `post_type` stops being limited to `post`/`page`. On first use, the extension reads `/wp/v2/types` for that site and allows any type with a REST base, e.g. `product`, `locations`, `infographics`, `customer-stories`. Unknown types are refused.
- Existing tools then work on them: `list_posts`, `get_post`, `update_draft`, `edit_published_post`, `unpublish_post`, `list_blocks`/`edit_blocks`. Field rules come from the type's REST schema (`OPTIONS /wp/v2/product`), so `categories`/`tags` map to that type's own taxonomies (`product_cat`, `product_tag`).
- WooCommerce-only fields use WooCommerce's API, with new tool **`update_product(site_id, product_id, …)`**: `regular_price`, `sale_price`, `short_description`, `sku`, `stock_status`, `images` (gallery, by media ID), `attributes`, `categories` → `PUT /wc/v3/products/{id}`. It uses the same Application Password (Basic auth over HTTPS). *To confirm on each site with one read call (`GET /wc/v3/products/{id}`) when the site is added to the extension.*
- The SEO Bridge registers its `mkt_seo` field for **every public post type**, not just posts and pages (bridge 1.2). Rank Math and Yoast store product SEO the same way as page SEO.

**Example (AMB product 9329):** *"Set the sale price of 26x35x10 Triple Wide Carport to $X and update its meta description."* → `update_product` (price) + `edit_published_post` with `post_type: "product"` (SEO), each with your approval.

**Caveat (verified):** AMB/AAMB product pages show **0%** of their text in the product description. The rest comes from ACF fields (Path 4) and the WooCommerce template. Price, short description and SEO are covered here; long marketing text needs Path 4.

**Needs on the sites:** SEO Bridge 1.2 for product SEO. **Extension work:** type discovery, `update_product`, tests.

---

## Path 3: Categories and sub-categories (`product_cat` terms)

**How it works:**

- New tools **`list_terms(site_id, taxonomy)`**, **`get_term`** and **`update_term(site_id, taxonomy, term_id, {name, slug, description, parent, seo, confirm_name, confirm_edit})`**.
- Name, slug, description and parent go through `POST /wp/v2/product_cat/{id}` (WordPress core, verified route).
- **Category SEO is stored differently from page SEO**, so it needs the bridge (1.2):
  - Yoast: the `wpseo_taxonomy_meta` option (`[taxonomy][term_id][wpseo_title|wpseo_desc|wpseo_focuskw|wpseo_canonical]`). The bridge writes it through Yoast's own `WPSEO_Taxonomy_Meta::set_values()`, so Yoast's cache updates too.
  - Rank Math: term meta `rank_math_title`, `rank_math_description`, `rank_math_focus_keyword`, `rank_math_canonical_url`.
  - The bridge adds an `mkt_seo` field to terms, just as it does for posts.
- Category descriptions are often 0% of the visible page (verified on AMB, AAMB, QSB). The rest comes from ACF fields on the term (Path 4) or the theme.

**Example (AMB "Metal Carports", term 16):** *"Change the Metal Carports category SEO title to '…'."* → `update_term` with `seo.title` → bridge updates Yoast → the live `<title>` changes, verified with the same check as the SEO Bridge test.

**Needs on the sites:** SEO Bridge 1.2. **Extension work:** term tools, tests. **Bridge work:** term SEO for Yoast and Rank Math.

---

## Path 4: Custom fields (state, city, pricing, financing and Safeway pages; product and category extras)

This is where most of the visible text on AMB, AAMB, QSB and Safeway lives.

**Two ways to open the fields. Both are concrete; you choose per site:**

| | A. Turn on "Show in REST API" in ACF | B. SEO Bridge 1.2 `mkt_fields` |
| --- | --- | --- |
| What you do | In WordPress: *ACF → Field Groups → (group) → Settings → Show in REST API → On*, for each group you want editable | Nothing in ACF; the bridge exposes the fields |
| How the tool reads/writes | `GET/POST /wp/v2/pages/{id}` with `acf: {...}` (ACF's own REST support; already works on Safeway) | `GET/POST /wp/v2/pages/{id}` with `mkt_fields: {...}`, implemented with ACF's `get_field_objects()` / `update_field()` |
| Who can see the values | Anyone, for public pages, as REST output (already the case on Safeway) | Only logged-in users who can edit the post |
| Works for non-ACF fields (QSB if not ACF) | No | Yes, with a per-site allowlist of meta keys |
| Effort | No code; a few clicks per group | Bridge release, tested in the PHP harness like 1.1.0 |

**Recommended:** **B**. It keeps field values private, works the same on every site, and covers QSB/DMS even if their fields aren't ACF.

**How it works (both options):**

1. New tool **`inspect_fields(site_id, object)`** lists the fields on that page, product or category: field name, label, type (text, textarea, wysiwyg, url, image, repeater, flexible content…), current value, and whether it's writable. One call on one page per template answers the open question about QSB/DMS.
2. New tool **`update_fields(site_id, object, fields, confirm_title, confirm_edit)`**:
   - Simple fields (`text`, `textarea`, `wysiwyg`, `url`, `number`, `image` by media ID): set by name.
   - **Repeater and flexible content** (e.g. Safeway `full_page_content`): the tool reads the full current value, changes only the addressed row/sub-field (`full_page_content[1].2_column_content_row[0].2_column_content_text`), and writes the full structure back, so other rows are preserved. Layout names (`acf_fc_layout`) are never changed.
   - Before writing, the value types are checked against the field definitions from `inspect_fields`; mismatches are refused.
3. Same safety as live edits: current title confirmed, `expected_modified_gmt` guard, diff of changed fields returned. ACF values are post meta, which WordPress does not keep revisions of, so the **tool saves the previous values in its response and can write them back** (`restore` from that response).

**Example (Safeway Virginia, page 2549, verified structure):** *"In the Virginia page, second section, change the text to '…'."* → `inspect_fields` shows `full_page_content`: 3 rows of `2_column_content` → `update_fields` changes `[1]…_text` → the other rows and images stay as they are.

**Needs on the sites:** SEO Bridge 1.2, or option A clicks. **Extension work:** two tools, nested-path editing, tests. **Bridge work:** `mkt_fields` with the ACF API and meta allowlist, plus harness scenarios.

---

## Not in scope: page templates

Templates such as `state-page.php`, `city-page.php` and `financing-new.php` are theme PHP files. They decide the page **layout**, not its text. Editing them through Claude would mean editing live PHP on a production site, where one mistake can break every page using that template. Keep template changes in your developer's normal process (git or SFTP, staging first). The tool can still **switch** a page to another existing template (`template` field) if ever needed.

---

## Rollout order, and what each step unlocks

| Step | Unlocks | Needs on the site | Verified by |
| --- | --- | --- | --- |
| 1. Block-safe edits | DMS states (most important) and About Us; any block page | Nothing | Mocked tests, then one edit + revision restore on mktwptest.wasmer.app |
| 2. Products and custom post types | Product SEO/price/short description; QSB locations | Bridge 1.2 (for product SEO) | One `GET /wc/v3/products/{id}` per site; a test product edit on staging |
| 3. Categories | Category name/description/SEO | Bridge 1.2 | Live `<title>` check after a category SEO edit, as in the 1.1.0 test |
| 4. Custom fields | AMB/AAMB/QSB state, city, pricing, financing; Safeway pages; product and category extras | Bridge 1.3 | `inspect_fields` on one page per template; harness scenarios; one field edit + restore |

Before steps 2–4 on a site: add the site in the extension settings (Website 2–5) with an **Editor or Administrator** Application Password, and install SEO Bridge 1.2. Test on a staging copy first where one exists.
