import assert from "node:assert/strict";
import { test } from "node:test";
import type { SearchCacheHit } from "./cache.ts";
import type { ProviderSearchResponse, SearchProvider } from "./providers.ts";
import { type SearchDependencies, executeSearch } from "./search.ts";

function response(provider: SearchProvider, names: string[]): ProviderSearchResponse {
	return {
		provider,
		results: names.map((name) => ({
			title: name,
			url: `https://${provider}.example/${name}`,
			snippet: `${name} snippet`,
			source: `${provider}.example`,
		})),
	};
}

function cacheHit(provider: SearchProvider, names: string[]): SearchCacheHit {
	return {
		response: response(provider, names),
		createdAt: 1_000,
		expiresAt: 10_000,
		requestedLimit: 5,
		ageMs: 500,
	};
}

function isolatedDependencies(overrides: SearchDependencies = {}): SearchDependencies {
	return {
		env: {},
		readCache: async () => undefined,
		writeCache: async () => undefined,
		...overrides,
	};
}

test("auto checks both caches before network and prefers Exa", async () => {
	const cacheReads: SearchProvider[] = [];
	let networkCalls = 0;
	const result = await executeSearch("query", 5, "auto", "use", undefined, isolatedDependencies({
		env: { EXA_API_KEY: "exa-key", KAGI_API_TOKEN: "kagi-key" },
		readCache: async (provider) => {
			cacheReads.push(provider);
			return cacheHit(provider, [`${provider}-cached`]);
		},
		searchExa: async () => {
			networkCalls += 1;
			return response("exa", ["live"]);
		},
		searchKagi: async () => {
			networkCalls += 1;
			return response("kagi", ["live"]);
		},
	}));

	assert.deepEqual(cacheReads.sort(), ["exa", "kagi"]);
	assert.equal(networkCalls, 0);
	assert.equal(result.response.provider, "exa");
	assert.equal(result.details.cache.hit, true);
	assert.deepEqual(result.details.attemptedProviders, []);
});

test("auto uses a cached Kagi response without credentials when Exa cache misses", async () => {
	const result = await executeSearch("query", 5, "auto", "use", undefined, isolatedDependencies({
		readCache: async (provider) => (provider === "kagi" ? cacheHit("kagi", ["cached-kagi"]) : undefined),
		searchExa: async () => {
			throw new Error("network should not run");
		},
		searchKagi: async () => {
			throw new Error("network should not run");
		},
	}));

	assert.equal(result.response.provider, "kagi");
	assert.equal(result.response.results[0].title, "cached-kagi");
	assert.equal(result.details.cache.provider, "kagi");
});

test("auto routes live searches to Exa first and writes successful results", async () => {
	const calls: string[] = [];
	const writes: string[] = [];
	const result = await executeSearch("query", 5, "auto", "use", undefined, isolatedDependencies({
		env: { EXA_API_KEY: "exa-key", KAGI_API_TOKEN: "kagi-key" },
		searchExa: async () => {
			calls.push("exa");
			return response("exa", ["live-exa"]);
		},
		searchKagi: async () => {
			calls.push("kagi");
			return response("kagi", ["live-kagi"]);
		},
		writeCache: async (provider) => {
			writes.push(provider);
			return { createdAt: 1_000, expiresAt: 2_000, requestedLimit: 5, ageMs: 0 };
		},
	}));

	assert.deepEqual(calls, ["exa"]);
	assert.deepEqual(writes, ["exa"]);
	assert.equal(result.response.provider, "exa");
	assert.equal(result.details.cache.hit, false);
	assert.equal(result.details.cache.expiresAt, 2_000);
});

test("auto falls back to Kagi after Exa failure and reports diagnostics", async () => {
	const calls: string[] = [];
	const result = await executeSearch("query", 5, "auto", "off", undefined, isolatedDependencies({
		env: { EXA_API_KEY: "exa-key", KAGI_API_TOKEN: "kagi-key" },
		searchExa: async () => {
			calls.push("exa");
			throw new Error("HTTP 429 quota");
		},
		searchKagi: async () => {
			calls.push("kagi");
			return response("kagi", ["fallback"]);
		},
	}));

	assert.deepEqual(calls, ["exa", "kagi"]);
	assert.deepEqual(result.details.attemptedProviders, ["exa", "kagi"]);
	assert.equal(result.response.provider, "kagi");
	assert.match(result.details.fallbackReason ?? "", /Exa: HTTP 429 quota/);
});

test("auto falls back to Kagi after empty Exa results", async () => {
	const result = await executeSearch("query", 5, "auto", "off", undefined, isolatedDependencies({
		env: { EXA_API_KEY: "exa-key", KAGI_API_TOKEN: "kagi-key" },
		searchExa: async () => response("exa", []),
		searchKagi: async () => response("kagi", ["fallback"]),
	}));

	assert.equal(result.response.provider, "kagi");
	assert.match(result.details.fallbackReason ?? "", /Exa: returned no results/);
});

test("explicit providers use only their matching cache and never cross-fallback", async () => {
	const reads: SearchProvider[] = [];
	let kagiCalls = 0;
	await assert.rejects(
		executeSearch("query", 5, "exa", "use", undefined, isolatedDependencies({
			env: { EXA_API_KEY: "exa-key", KAGI_API_TOKEN: "kagi-key" },
			readCache: async (provider) => {
				reads.push(provider);
				return undefined;
			},
			searchExa: async () => {
				throw new Error("Exa failed");
			},
			searchKagi: async () => {
				kagiCalls += 1;
				return response("kagi", ["wrong fallback"]);
			},
		})),
		/Exa failed/,
	);
	assert.deepEqual(reads, ["exa"]);
	assert.equal(kagiCalls, 0);

	const cached = await executeSearch("query", 5, "kagi", "use", undefined, isolatedDependencies({
		readCache: async (provider) => (provider === "kagi" ? cacheHit("kagi", ["cached"] ) : undefined),
	}));
	assert.equal(cached.response.results[0].title, "cached");
});

test("auto reports both provider reasons when no live provider is configured", async () => {
	await assert.rejects(
		executeSearch("query", 5, "auto", "use", undefined, isolatedDependencies()),
		(error: Error) => {
			assert.match(error.message, /Exa: EXA_API_KEY is not set/);
			assert.match(error.message, /Kagi: KAGI_API_TOKEN is not set/);
			return true;
		},
	);
});

test("cancellation after Exa does not invoke Kagi", async () => {
	const controller = new AbortController();
	let kagiCalls = 0;
	await assert.rejects(
		executeSearch("query", 5, "auto", "off", controller.signal, isolatedDependencies({
			env: { EXA_API_KEY: "exa-key", KAGI_API_TOKEN: "kagi-key" },
			searchExa: async () => {
				controller.abort();
				return response("exa", []);
			},
			searchKagi: async () => {
				kagiCalls += 1;
				return response("kagi", ["must-not-run"]);
			},
		})),
		(error: Error) => error.name === "AbortError",
	);
	assert.equal(kagiCalls, 0);
});

test("refresh skips reads and updates cache while off performs no cache I/O", async () => {
	let reads = 0;
	let writes = 0;
	const dependencies = isolatedDependencies({
		env: { EXA_API_KEY: "exa-key" },
		readCache: async () => {
			reads += 1;
			return cacheHit("exa", ["stale"]);
		},
		writeCache: async () => {
			writes += 1;
			return undefined;
		},
		searchExa: async () => response("exa", ["fresh"]),
	});

	const refreshed = await executeSearch("query", 5, "exa", "refresh", undefined, dependencies);
	assert.equal(refreshed.response.results[0].title, "fresh");
	assert.equal(reads, 0);
	assert.equal(writes, 1);

	await executeSearch("query", 5, "exa", "off", undefined, dependencies);
	assert.equal(reads, 0);
	assert.equal(writes, 1);
});

test("cache failures do not prevent a successful live search", async () => {
	const result = await executeSearch("query", 5, "exa", "use", undefined, isolatedDependencies({
		env: { EXA_API_KEY: "exa-key" },
		readCache: async () => {
			throw new Error("unreadable cache");
		},
		writeCache: async () => {
			throw new Error("unwritable cache");
		},
		searchExa: async () => response("exa", ["success"]),
	}));
	assert.equal(result.response.results[0].title, "success");
});
