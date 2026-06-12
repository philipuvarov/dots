# Pi Light Web Search

Lightweight local Pi extension that adds `web_search` and `web_fetch` tools.

## Scope

- Kagi Search API is the primary provider.
- DuckDuckGo Instant Answer JSON is a limited best-effort fallback.
- `web_fetch` uses Kagi Extract when available, then direct HTTP fallback for readable HTML, text, and JSON.
- No browser cookies, YouTube/video handling, PDF extraction, binary fetching, GitHub cloning, curator UI, storage, or LLM synthesis.
- Kagi v1 search is called as `POST https://kagi.com/api/v1/search` with `Authorization: Bearer $KAGI_API_TOKEN`.
- Kagi v1 extract is called as `POST https://kagi.com/api/v1/extract` with `Authorization: Bearer <token>`.

## Install

Dotfiles setup symlinks this package into `~/.pi/agent/extensions/pi-light-web-search`, where Pi auto-discovers it.

Load directly for a single run:

```bash
pi --extension ~/.pi/agent/extensions/pi-light-web-search/index.ts
```

## Kagi Token

Set the token in the environment before starting Pi:

```bash
export KAGI_API_TOKEN="..."
```

`web_search` reads `process.env.KAGI_API_TOKEN`.

`web_fetch` reads `process.env.KAGI_API_TOKEN` first, then `process.env.KAGI_API_KEY`.

The extension does not write tokens to the repo or Pi config.

## Tools

Use `web_search` to discover URLs and current result metadata. Use `web_fetch` to read the readable contents of a known absolute URL.

### `web_search`

`web_search` parameters:

- `query: string`
- `numResults?: number` defaults to `5`, clamped to `1..10`
- `provider?: "auto" | "kagi" | "duckduckgo"` defaults to `"auto"`

Provider behavior:

- `auto`: uses Kagi when `KAGI_API_TOKEN` is set, otherwise falls back to DuckDuckGo. It also falls back on Kagi failure or empty Kagi results.
- `kagi`: requires `KAGI_API_TOKEN`; missing tokens are reported as a tool error.
- `duckduckgo`: uses DuckDuckGo Instant Answer JSON only and includes a warning that this is not full web search.

Tool output includes a readable numbered result list plus structured `details` with normalized results, provider metadata, attempted providers, fallback reason, and warnings.

### `web_fetch`

`web_fetch` parameters:

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

Tool output includes readable content plus structured `details` with `url`, `finalUrl`, `providerUsed`, `requestedProvider`, `status`, `contentType`, `contentLength`, `truncated`, and either `markdown` or `text`. `fallbackReason` and `warning` are included when relevant.

## Check

```bash
npm run check
```
