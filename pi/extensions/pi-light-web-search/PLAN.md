# Pi Light Web Search Update Plan

## Goal

Replace the ineffective DuckDuckGo Instant Answer fallback with Exa, preserve Kagi as the high-quality fallback and explicit provider, and add a persistent local search cache to reduce API usage.

## Proposed behavior

### Search routing

| Requested provider | Behavior |
| --- | --- |
| `auto` | Fresh cache → Exa → Kagi → combined error |
| `exa` | Exa cache → Exa only |
| `kagi` | Kagi cache → Kagi only |

For `auto`, check both Exa and Kagi caches before making any network request. This preserves previously cached Kagi results without spending credits. Live Exa becomes the default provider to conserve Kagi credits; Kagi remains the quality fallback and can always be requested explicitly.

Fallback occurs on empty results, quota errors such as HTTP 402/429, and provider failures. Cancellation must stop routing immediately rather than trigger another provider.

## Implementation steps

### 1. Replace DuckDuckGo with Exa in `providers.ts`

- Change `SearchProvider` to `"exa" | "kagi"`.
- Add `searchExa()` using:
  - `POST https://api.exa.ai/search`
  - `x-api-key: $EXA_API_KEY`
  - `type: "auto"`
  - `contents: { highlights: true }`
- Normalize Exa titles, URLs, highlights, publication dates, and source domains into the existing `SearchResult` shape.
- Build snippets from Exa highlights, with summary or text as defensive fallbacks when present.
- Remove all DuckDuckGo constants, parsing helpers, warnings, and exports.
- Improve generic provider error parsing for Exa's `error`, `tag`, and `requestId` fields while continuing to redact API keys.

### 2. Update routing and tool schema in `index.ts`

- Change the public provider enum to `"auto" | "exa" | "kagi"`.
- Make Exa the first live provider under `auto`.
- Preserve explicit-provider behavior without cross-provider fallback.
- Aggregate fallback diagnostics so failures identify both Exa and Kagi reasons.
- Do not fall back after an aborted request.
- Add a `prepareArguments` compatibility shim that maps legacy stored `provider: "duckduckgo"` arguments to `"exa"` before validation.
- Update tool descriptions, labels, output formatting, and prompt guidelines for Exa and caching.

### 3. Add a persistent search cache in `cache.ts`

- Cache `web_search` results only; leave `web_fetch` uncached in this update.
- Store entries under:
  - `$XDG_CACHE_HOME/pi-light-web-search/`, when set; otherwise
  - `~/.cache/pi-light-web-search/`.
- Use one versioned JSON file per hashed provider/query key to avoid a shared JSON-file write bottleneck between Pi processes.
- Use a default TTL of six hours, configurable through an environment variable.
- Cache only successful, non-empty provider responses.
- Record the original requested result limit so a wider cached result set can satisfy later requests for fewer results.
- Preserve the widest fresh result set when concurrent or smaller requests write the same key.
- Write through a temporary file and atomic rename.
- Create the cache directory and files with private permissions.
- Never store API keys or authorization headers.
- Treat missing, corrupt, expired, or unwritable entries as nonfatal cache misses.
- Lazily purge expired entries so the cache cannot grow indefinitely.

### 4. Add cache control to `web_search`

Add an optional `cacheMode` parameter:

- `"use"` — default; read and write cache.
- `"refresh"` — skip cache lookup, perform a live request, and update the cache.
- `"off"` — neither read nor write cache.

Extend structured tool details with cache metadata such as hit status, age, and expiration. Mark cache hits clearly in the readable tool output.

Cache lookup rules:

1. For `auto`, look for fresh Exa and Kagi entries before any live request.
2. Prefer a fresh Exa entry, followed by a fresh Kagi entry.
3. If neither is cached, call configured live providers in Exa → Kagi order.
4. Explicit `exa` and `kagi` requests only consult the matching provider cache.
5. Cached entries may still be used if the corresponding API key is currently absent because the cached data contains no credentials.

### 5. Keep `web_fetch` behavior unchanged

- Continue using Kagi Extract first under `provider: "auto"`, followed by direct HTTP on failure or missing credentials.
- Keep explicit `"kagi"` and `"direct"` behavior.
- Do not add Exa Contents integration or fetch caching in this update.

### 6. Add automated tests

Add Node test-runner coverage:

- `providers.test.ts`
  - Exa endpoint, headers, and request body.
  - Highlight and metadata normalization.
  - Malformed result filtering.
  - Exa error parsing and API-key redaction.
  - Existing Kagi normalization and error handling regressions.
- `cache.test.ts`
  - Cache hits and misses.
  - TTL expiration.
  - Result slicing and requested-limit behavior.
  - Refresh and off modes.
  - Corrupt entry handling.
  - Atomic writes and cleanup.
- `search.test.ts`
  - Cache-before-network behavior.
  - Exa-first live routing.
  - Kagi fallback after Exa failure or empty results.
  - Explicit providers do not cross-fallback.
  - Clear error when no live provider is configured and no cache is available.
  - Cancellation does not invoke another provider.

Add an `npm test` script and make `npm run check` run the tests before the existing Pi extension load check.

### 7. Update documentation and package metadata

- Document `EXA_API_KEY` alongside the existing Kagi variables.
- Document provider order, explicit provider behavior, cache location, TTL, and `cacheMode`.
- Remove DuckDuckGo documentation and warnings.
- Keep Kagi Search, Kagi Extract, and direct-fetch documentation.
- Bump the local package version from `0.1.0` to `0.2.0` because the provider enum changes.

## Acceptance criteria

- `duckduckgo` is no longer offered or called by new tool requests.
- `auto` serves a fresh cached result before making an API request.
- Without a cache hit, `auto` tries Exa before Kagi.
- Kagi remains directly selectable and is used when Exa fails or returns no results under `auto`.
- Explicit provider requests never silently switch to another live provider.
- API keys never appear in errors, tool output, or cache files.
- Cache failures never prevent a successful live search.
- Aborted searches do not continue to a fallback provider.
- Existing `web_fetch` behavior remains unchanged.
- All automated tests and the Pi extension load check pass.
