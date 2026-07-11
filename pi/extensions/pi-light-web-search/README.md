# Pi Light Web Search

Lightweight local Pi extension that adds `web_search` and `web_fetch` tools.

## Scope

- `web_search` checks a persistent local cache, then uses Exa Search with Kagi Search as the `auto` fallback.
- `web_fetch` uses Kagi Extract when available, then direct HTTP fallback for readable HTML, text, and JSON.
- No browser cookies, YouTube/video handling, PDF extraction, binary fetching, GitHub cloning, curator UI, or LLM synthesis.
- Exa Search is called as `POST https://api.exa.ai/search` with `x-api-key: $EXA_API_KEY`.
- Kagi v1 search is called as `POST https://kagi.com/api/v1/search` with `Authorization: Bearer $KAGI_API_TOKEN`.
- Kagi v1 extract is called as `POST https://kagi.com/api/v1/extract` with `Authorization: Bearer <token>`.

## Install

Dotfiles symlink `pi/extensions/` to `~/.pi/agent/extensions/`, where Pi auto-discovers this package via `index.ts`.

Load directly for a single run:

```bash
pi --extension ~/.pi/agent/extensions/pi-light-web-search/index.ts
```

## Credentials

Set one or both search credentials before starting Pi:

```bash
export EXA_API_KEY="..."
export KAGI_API_TOKEN="..."
```

`web_search` reads `EXA_API_KEY` for Exa and `KAGI_API_TOKEN` for Kagi. Under `provider: "auto"`, Exa is the first live provider and Kagi is the fallback.

`web_fetch` reads `KAGI_API_TOKEN` first, then `KAGI_API_KEY`. Its routing is unchanged and does not use Exa.

The extension does not write credentials to the repo, tool output, or cache.

## Tools

Use `web_search` to discover URLs and current result metadata. Use `web_fetch` to read the readable contents of a known absolute URL.

### `web_search`

Parameters:

- `query: string`
- `numResults?: number` defaults to `5`, clamped to `1..10`
- `provider?: "auto" | "exa" | "kagi"` defaults to `"auto"`
- `cacheMode?: "use" | "refresh" | "off"` defaults to `"use"`

Provider behavior:

- `auto`: checks fresh Exa and Kagi cache entries, preferring Exa. With no usable cache, it calls Exa first and then Kagi when Exa fails or returns no results.
- `exa`: checks only the Exa cache and, if needed, requires `EXA_API_KEY`. It never switches to Kagi.
- `kagi`: checks only the Kagi cache and, if needed, requires `KAGI_API_TOKEN`. It never switches to Exa.

A cache hit can be used even when the matching provider credential is not currently set. Aborting an Exa request stops routing and does not trigger Kagi.

Cache modes:

- `use`: read fresh entries and write successful, non-empty live responses.
- `refresh`: skip reads, perform a live request, and update the cache.
- `off`: do not read or write cache entries.

Tool output includes a readable numbered result list plus structured `details` with normalized results, provider metadata, attempted providers, fallback diagnostics, and cache hit/age/expiration metadata.

#### Search cache

Cache files are stored under:

- `$XDG_CACHE_HOME/pi-light-web-search/` when `XDG_CACHE_HOME` is set; otherwise
- `~/.cache/pi-light-web-search/`.

Each provider/query pair uses a separate versioned, hashed JSON file. Files are written by atomic rename with private permissions. Only successful non-empty normalized search results are stored; credentials and authorization headers are never cached. Corrupt, expired, missing, or unwritable entries are treated as nonfatal misses.

The default TTL is six hours. Override it in milliseconds with:

```bash
export PI_LIGHT_WEB_SEARCH_CACHE_TTL_MS=21600000
```

`PI_LIGHT_WEB_SEARCH_CACHE_TTL_HOURS` is also accepted as a convenience alias.

### `web_fetch`

Parameters:

- `url: string` required absolute `http:` or `https:` URL
- `maxChars?: number` defaults to `12000`, clamped to `1..50000`
- `provider?: "auto" | "kagi" | "direct"` defaults to `"auto"`

Provider behavior:

- `auto`: uses Kagi Extract when `KAGI_API_TOKEN` or `KAGI_API_KEY` is set. If Kagi is unavailable or returns an error for the URL, it falls back to direct HTTP fetch.
- `kagi`: requires `KAGI_API_TOKEN` or `KAGI_API_KEY`; missing tokens are reported as a tool error.
- `direct`: uses built-in `fetch`, follows normal redirects, and reports the final response URL.

Kagi Extract sends:

```json
{ "pages": [{ "url": "https://example.com/" }] }
```

Direct HTTP supports `text/html`, `text/plain`, `application/json`, and `+json` content types. HTML has scripts and styles removed, the title is extracted when available, common entities are decoded, tags are stripped, and whitespace is normalized. JSON is pretty-printed when parseable; otherwise the raw response text is returned. PDFs, binary responses, and unknown content types are rejected with a clear error.

Tool output includes readable content plus structured `details` with `url`, `finalUrl`, `providerUsed`, `requestedProvider`, `status`, `contentType`, `contentLength`, `truncated`, and either `markdown` or `text`. `fallbackReason` and `warning` are included when relevant. `web_fetch` is not cached.

## Test and check

```bash
npm test
npm run check
```

`npm run check` runs the Node test suite before verifying that Pi can load the extension.
