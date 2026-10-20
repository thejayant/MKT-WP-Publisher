# Development

## Prerequisites

- Node.js 18+ (tested on 22.22.0 and 25.1.0)
- No `npm install` needed. There are no dependencies.

## Run the tests

```bash
npm test
```

The suite (`test/multi-site.test.js`, 54 tests) uses `node:test` and a mocked `fetch`. It makes **no real WordPress requests**. It covers:

- config parsing and precedence, placeholders, the 5-site limit, URL rules
- credential isolation and that nothing leaks into output
- site routing with overlapping IDs, and the slug-duplicate check per site
- draft/publish safeguards (title match, future date, status)
- image folder isolation, traversal, and symlinks (skipped if the OS refuses symlinks)
- cancellation, and the JSON-RPC layer (spawns `server/index.js`)
- authors (Admin vs Editor fallback only on permission errors, error hints)
- error reporting (non-JSON pages, WordPress messages, which site is misconfigured) and tool annotations
- pages, scheduling, SEO fields (bridge detection via OPTIONS) and the Markdown converter
- the manifest shape (5 groups, sensitive passwords, folder pickers, version match)

## Run the server by hand

```bash
node server/index.js
```

Then type JSON-RPC lines on stdin, for example:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```

Set env vars first (see [ARCHITECTURE.md](ARCHITECTURE.md#configuration--environment)). Use a **staging** WordPress site and a test Application Password for any live check.

For interactive testing you can also use the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node server/index.js
```

## Package the extension

```bash
npx @anthropic-ai/mcpb pack . ../mkt-wp-publisher-1.3.0.mcpb
```

`.mcpbignore` keeps `test/`, `docs/`, `wordpress-plugin/` and old bundles out of the `.mcpb`.

## Package the SEO Bridge plugin

The WordPress plugin ships separately, as a zip that WordPress can install (*Plugins → Add New → Upload Plugin*). The zip must contain the `mkt-wp-publisher-seo-bridge/` folder at its root:

```powershell
Compress-Archive -Path wordpress-plugin\mkt-wp-publisher-seo-bridge -DestinationPath ..\mkt-wp-publisher-seo-bridge.zip -Force
```

Bump its `Version:` header when you change it. Test it on a staging site with Yoast and with Rank Math. It has not been run or linted yet.

## Adding a tool

1. Add a `tool(...)` entry to `tools` in `server/service.js`. Set `readOnly` correctly.
2. Add a handler branch in `call()`. Use `request()` so the call is site-scoped, cancellable and has a timeout.
3. Return through `result(...)` so `site_id`/`site_url` are attached.
4. Add it to `manifest.json` → `tools`.
5. Update the `tools.length` assertion in the tests and add tests with the `mock()` helper.
6. Document it in `README.md` and `docs/TOOLS_REFERENCE.md`.

## Release checklist

- [ ] Bump the version in `server/service.js` (`VERSION`), `manifest.json`, `package.json` and the README headings.
- [ ] Add a `CHANGELOG.md` entry, including any tool-call migration notes.
- [ ] `npm test` passes.
- [ ] Pack the `.mcpb`, install it in Claude Desktop, and check the version and tool count.
- [ ] Smoke test on a staging site: `list_sites` → `test_connection` → `upload_image` → `create_draft` → `update_draft` → `publish_post`.
- [ ] Keep the previous `.mcpb` for rollback.
