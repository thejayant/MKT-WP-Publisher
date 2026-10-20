# Gap Analysis & Improvement Backlog

_Review date: 2026-10-20 · reviewed codebase v1.1.0 · status updated for v1.4.0_

The original review found strong safety rails (no implicit site, draft-first publishing, title-confirmed publish, sandboxed image folder, no credential leaks) and good mocked test coverage. The gaps fell into three groups: small bugs, missing workflow features, and project hygiene. Almost all of them are now done. The few open items are listed first.

## Still open

| # | Item | Notes |
| --- | --- | --- |
| H8 | **LICENSE and `repository` fields** | Needs a decision from the owner: which license (e.g. proprietary/internal, MIT), and where the repository will live. |
| F7b | **Custom post types** (beyond posts and pages) | `post_type` is limited to `post`/`page`. CPTs need their REST base and taxonomy rules per site. |
| F12b | **Native block markup** for Markdown | Markdown becomes HTML (a Classic block, one click to convert). Native blocks risk editor validation warnings across WordPress versions. |
| F14b | **Image resize/compress** | Would need an image library (a dependency). WordPress already creates resized copies on upload. |
| F19 | **Unschedule tool** | Moving a scheduled post back to draft is done in WordPress for now. |
| F18 | **More than 5 sites** | Only if needed. It's a manifest limit (static settings groups), so JSON profiles would be the way to do it. |
| H5b | **Reformat older test bodies** | The tests are split by area and new tests are readable. Older test bodies are still compact. A formatter (Prettier) would need a dev dependency. |
| H7b | **ESLint/Prettier** | `npm run lint` is dependency-free (syntax, whitespace, consistency). Full linting would need dev dependencies. |
| F8b | **Upload from a URL** | Deliberately not done. It would let the server fetch arbitrary URLs (a server-side request forgery risk) and upload untrusted files. Download to the image folder first. |

---

## 1. Bugs & rough edges

| # | Issue | Status |
| --- | --- | --- |
| B1 | Non-JSON error pages hid the HTTP status. | ✅ 1.1.1 |
| B2 | WordPress's own error `message` was dropped. | ✅ 1.1.1 |
| B3 | Config errors didn't say which website was wrong. | ✅ 1.1.1 |
| B4 | `update_draft` with no fields still wrote. | ✅ 1.1.1 |
| B5 | Blank `alt_text` was accepted. | ✅ 1.1.1 |
| B6 | Stale "v1.1.x" wording in the manifest. | ✅ 1.1.1 |
| B7 | `list_authors` fell back on any error. | ✅ 1.1.1 |
| B8 | Coarse tool annotations. | ✅ 1.1.1 |
| B9 | The slug duplicate check ran only on create; WordPress silently added `-2`. | ✅ 1.4.0: checked on update, warning if WordPress changes it |
| B10 | A fixed 60 s timeout could cut off large uploads. | ✅ 1.4.0: 180 s for uploads |

## 2. Features

| # | Feature | Status |
| --- | --- | --- |
| F1 | `list_images` | ✅ 1.2.0 |
| F2 | `list_posts` | ✅ 1.2.0 |
| F3 | SEO fields (Yoast / Rank Math) | ✅ 1.3.0, via the SEO Bridge plugin |
| F4 | `create_term` | ✅ 1.2.0 |
| F5 | Lean responses | ✅ 1.2.0 |
| F6 | Scheduling (`schedule_post`) | ✅ 1.3.0 |
| F7 | Pages | ✅ 1.3.0 (custom post types still open, see F7b) |
| F8 | Inline image helper | ✅ 1.4.0: `html` figure plus `featured_for_post_id` (URL upload declined, see F8b) |
| F9 | Plain-permalink support | ✅ 1.2.0 |
| F10 | Local dev sites over `http://` | ✅ 1.4.0: localhost, *.local, *.test, *.localhost only |
| F11 | Preview link | ✅ 1.2.0 |
| F12 | Markdown → HTML | ✅ 1.3.0 (native blocks still open, see F12b) |
| F13 | Concurrency guard | ✅ 1.4.0: `expected_modified_gmt` |
| F14 | Image checks; GIF/AVIF | ✅ 1.4.0: content sniffing, GIF, AVIF (resize still open, see F14b) |
| F15 | Per-site queue | ✅ 1.4.0 |
| F16 | `outputSchema` + `structuredContent` | ✅ 1.4.0 |
| F17 | Retry for safe reads | ✅ 1.4.0 |

## 3. Project hygiene

| # | Item | Status |
| --- | --- | --- |
| H1 | Git repository, `.gitignore` | ✅ 1.4.0 (local; no remote yet) |
| H2 | `pack` script and `.mcpbignore` | ✅ 1.4.0: `npm run pack` builds the `.mcpb` and the plugin zip |
| H3 | CI | ✅ 1.4.0: `.github/workflows/ci.yml`, runs once pushed to GitHub |
| H4 | Readability refactor of the server | ✅ 1.4.0: `server/` modules |
| H5 | Split the test file | ✅ 1.4.0: by area (older bodies not reformatted, see H5b) |
| H6 | Live integration test | ✅ 1.4.0: `npm run test:live` |
| H7 | Lint | ✅ 1.4.0: dependency-free `npm run lint` (ESLint still open, see H7b) |
| H8 | LICENSE and `repository` | Open, needs an owner decision |
| H9 | Debug log | ✅ 1.4.0: Advanced → Debug log setting |
