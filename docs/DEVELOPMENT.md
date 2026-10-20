# Development

## Prerequisites

- Node.js 18+ (tested on 22.22.0 and 25.1.0; CI covers 18, 20 and 22 on Linux, Windows and macOS)
- No `npm install` needed. There are no dependencies.
- Optional: PHP 7.4+ on your PATH, so `npm run lint` also checks the SEO Bridge plugin.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | All `test/*.test.js` files with `node:test` (via `scripts/test.js`). Mocked `fetch`; **no real WordPress requests**. |
| `npm run lint` | `node --check` on every JS file; no trailing whitespace or tabs; manifest, package.json and server agree on version, tool list and settings; `php -l` on the plugin when PHP is installed. |
| `npm run pack` | Lint, then tests, then the `.mcpb` (via `npx @anthropic-ai/mcpb pack`) and `mkt-wp-publisher-seo-bridge.zip`, written to the parent folder. Options: `-- --out <folder>`, `-- --plugin-only`. |
| `npm run test:live` | Opt-in round trip against a real staging site (see below). |

## Tests

| File | Covers |
| --- | --- |
| `test/config.test.js` | Settings parsing and precedence, placeholders, the 5-site limit, URL rules, error messages that name the site, manifest shape |
| `test/routing.test.js` | Site isolation and credentials, unknown sites, HTTP errors, plain permalinks, local http, retries, timeouts, debug log |
| `test/posts.test.js` | Drafts, updates, publishing, scheduling, pages, SEO fields, Markdown content, slug and concurrency guards |
| `test/taxonomy-authors.test.js` | Authors (Admin vs Editor fallback), categories and tags paging, `create_term` |
| `test/media.test.js` | Image folders, traversal, symlinks (skipped where the OS refuses them), content sniffing, featured images |
| `test/rpc.test.js` | JSON-RPC envelope, cancellation, per-site queues, `structuredContent`/`outputSchema`, tool annotations |
| `test/markdown.test.js` | The Markdown converter |
| `test/helpers.js` | Shared fixtures: `sites`, `env`, `mock()`, `slot()`, `runChild()`, `seoSchema()`, `png()` |

`mock(values)` returns `{calls, f}`. `f` is a fake `fetch` that answers with the next queued value, and records each URL and option in `calls`. `runChild(messages, bootstrap)` runs `server/index.js` as a child process and returns the parsed JSON-RPC replies.

### Live test against staging

`test/live/wordpress.live.js` runs the real server code against a real site. **Use a staging site, never production.** It never publishes or schedules.

```powershell
$env:WP_LIVE_URL = "https://staging.example.com"
$env:WP_LIVE_USERNAME = "editor"
$env:WP_LIVE_APP_PASSWORD = "xxxx xxxx xxxx xxxx xxxx xxxx"
$env:WP_LIVE_ALLOW_WRITES = "yes"   # create, update and trash one test draft
$env:WP_LIVE_UPLOAD = "yes"         # also upload, attach and delete a 1x1 PNG
$env:WP_LIVE_SEO = "yes"            # also write SEO fields (needs the SEO Bridge plugin)
npm run test:live
```

Without the three required variables, the test is skipped. Without `WP_LIVE_ALLOW_WRITES=yes`, it only reads.

## Run the server by hand

```bash
node server/index.js
```

Then type JSON-RPC lines on stdin, for example:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```

Set env vars first (see [ARCHITECTURE.md](ARCHITECTURE.md#configuration--environment)). `MKT_WP_DEBUG=true` prints one line per WordPress request to stderr. For interactive testing you can also use the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node server/index.js
```

## Packaging

`npm run pack` builds both release files. `.mcpbignore` keeps `test/`, `docs/`, `scripts/`, `wordpress-plugin/`, git files, CI config and old bundles out of the `.mcpb`.

The SEO Bridge zip contains the `mkt-wp-publisher-seo-bridge/` folder at its root, which is what WordPress's *Upload Plugin* expects. `scripts/zip.js` writes it without dependencies. Bump the plugin's `Version:` header when you change it, and test it on a staging site with Yoast and with Rank Math.

## Adding a tool

1. Add a `tool(...)` entry to `tools` in `server/schema.js`. Set `readOnly`, and `hints.destructiveHint` only if it makes content public.
2. Add the handler to the right `server/tools/*.js` module, as `async name(ctx, args)`. Use `ctx.request()` so the call is site-scoped, cancellable, timed and logged. Return `ctx.result(data)`.
3. Add it to `manifest.json` → `tools`, in the same order. `npm run lint` checks this.
4. Update the `tools.length` assertion in `test/rpc.test.js` and add tests with `mock()`.
5. Document it in `README.md` and `docs/TOOLS_REFERENCE.md`.

## Continuous integration

`.github/workflows/ci.yml` runs `npm run lint` and `npm test` on Node 18/20/22 × Ubuntu/Windows/macOS, and `php -l` on PHP 7.4 and 8.3. It starts working once the repository is pushed to GitHub.

## Release checklist

- [ ] Bump the version in `server/constants.js` (`VERSION`), `manifest.json`, `package.json` and the README/User Guide headings (`npm run lint` catches mismatches between the first three).
- [ ] Add a `CHANGELOG.md` entry, including any tool-call migration notes.
- [ ] `npm run pack` (runs lint and tests first).
- [ ] Install the `.mcpb` in Claude Desktop and check the version and tool count.
- [ ] `npm run test:live` against staging, or a manual smoke test: `list_sites` → `test_connection` → `upload_image` → `create_draft` → `update_draft` → `publish_post`.
- [ ] Commit, tag (`git tag v<version>`), and keep the previous `.mcpb` for rollback.
