import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	DEFAULT_SEARCH_CACHE_TTL_MS,
	getSearchCacheDirectory,
	getSearchCacheFilePath,
	getSearchCacheTtlMs,
	purgeExpiredSearchCache,
	readSearchCache,
	writeSearchCache,
} from "./cache.ts";
import type { SearchResult } from "./providers.ts";

const temporaryRoots: string[] = [];

async function temporaryCache(): Promise<{ root: string; cacheDir: string }> {
	const { mkdtemp } = await import("node:fs/promises");
	const root = await mkdtemp(join(tmpdir(), "pi-light-web-search-test-"));
	temporaryRoots.push(root);
	return { root, cacheDir: join(root, "cache") };
}

function results(count: number, prefix = "result"): SearchResult[] {
	return Array.from({ length: count }, (_, index) => ({
		title: `${prefix}-${index + 1}`,
		url: `https://example.com/${prefix}/${index + 1}`,
		snippet: `Snippet ${index + 1}`,
		source: "example.com",
	}));
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("cache location honors XDG_CACHE_HOME and TTL configuration", () => {
	assert.equal(
		getSearchCacheDirectory({ XDG_CACHE_HOME: "/tmp/custom-cache" }),
		"/tmp/custom-cache/pi-light-web-search",
	);
	assert.equal(getSearchCacheTtlMs({}), DEFAULT_SEARCH_CACHE_TTL_MS);
	assert.equal(getSearchCacheTtlMs({ PI_LIGHT_WEB_SEARCH_CACHE_TTL_MS: "1234" }), 1234);
	assert.equal(getSearchCacheTtlMs({ PI_LIGHT_WEB_SEARCH_CACHE_TTL_HOURS: "2" }), 7_200_000);
	assert.equal(getSearchCacheTtlMs({ PI_LIGHT_WEB_SEARCH_CACHE_TTL_MS: "invalid" }), DEFAULT_SEARCH_CACHE_TTL_MS);
});

test("cache returns misses, hits, and sliced results based on the requested limit", async () => {
	const { cacheDir } = await temporaryCache();
	const options = { cacheDir, now: 1_000, ttlMs: 10_000 };
	assert.equal(await readSearchCache("exa", "query", 3, options), undefined);

	await writeSearchCache("exa", "query", 5, results(5), options);
	const hit = await readSearchCache("exa", "query", 3, { ...options, now: 1_500 });
	assert.ok(hit);
	assert.equal(hit.response.provider, "exa");
	assert.equal(hit.response.results.length, 3);
	assert.equal(hit.requestedLimit, 5);
	assert.equal(hit.ageMs, 500);
	assert.equal(await readSearchCache("exa", "query", 6, { ...options, now: 1_500 }), undefined);
	assert.equal(await readSearchCache("kagi", "query", 3, { ...options, now: 1_500 }), undefined);
});

test("a wider requested response can satisfy a later limit even when the provider returned fewer items", async () => {
	const { cacheDir } = await temporaryCache();
	await writeSearchCache("exa", "sparse", 5, results(2), { cacheDir, now: 100, ttlMs: 1_000 });

	const hit = await readSearchCache("exa", "sparse", 4, { cacheDir, now: 200 });
	assert.ok(hit);
	assert.equal(hit.requestedLimit, 5);
	assert.equal(hit.response.results.length, 2);
});

test("refresh writes replace an equally wide fresh entry", async () => {
	const { cacheDir } = await temporaryCache();
	await writeSearchCache("exa", "refresh", 5, results(5, "old"), { cacheDir, now: 1_000, ttlMs: 10_000 });
	await writeSearchCache("exa", "refresh", 5, results(3, "fresh"), {
		cacheDir,
		now: 2_000,
		ttlMs: 10_000,
		replaceEqualLimit: true,
	});

	const hit = await readSearchCache("exa", "refresh", 5, { cacheDir, now: 2_100 });
	assert.equal(hit?.createdAt, 2_000);
	assert.equal(hit?.response.results[0].title, "fresh-1");
	assert.equal(hit?.response.results.length, 3);
});

test("expired entries become misses and are removed", async () => {
	const { cacheDir } = await temporaryCache();
	const writeOptions = { cacheDir, now: 1_000, ttlMs: 100 };
	await writeSearchCache("exa", "expiring", 5, results(1), writeOptions);
	const path = getSearchCacheFilePath("exa", "expiring", writeOptions);

	assert.ok(await readSearchCache("exa", "expiring", 5, { cacheDir, now: 1_099 }));
	assert.equal(await readSearchCache("exa", "expiring", 5, { cacheDir, now: 1_100 }), undefined);
	await assert.rejects(stat(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("corrupt entries are nonfatal misses and are deleted", async () => {
	const { cacheDir } = await temporaryCache();
	await mkdir(cacheDir, { recursive: true });
	const options = { cacheDir };
	const path = getSearchCacheFilePath("kagi", "corrupt", options);
	await writeFile(path, "{not-json", "utf8");

	assert.equal(await readSearchCache("kagi", "corrupt", 5, options), undefined);
	await assert.rejects(stat(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("smaller and concurrent writes preserve the widest fresh result set", async () => {
	const { cacheDir } = await temporaryCache();
	const options = { cacheDir, now: 1_000, ttlMs: 10_000 };
	await writeSearchCache("exa", "sequential", 5, results(5, "wide"), options);
	await writeSearchCache("exa", "sequential", 2, results(2, "narrow"), { ...options, now: 1_100 });
	const sequential = await readSearchCache("exa", "sequential", 5, { ...options, now: 1_200 });
	assert.equal(sequential?.response.results[0].title, "wide-1");
	assert.equal(sequential?.createdAt, 1_000);

	await Promise.all([
		writeSearchCache("kagi", "concurrent", 2, results(2, "narrow"), options),
		writeSearchCache("kagi", "concurrent", 5, results(5, "wide"), options),
	]);
	const concurrent = await readSearchCache("kagi", "concurrent", 5, { ...options, now: 1_200 });
	assert.equal(concurrent?.requestedLimit, 5);
	assert.equal(concurrent?.response.results.length, 5);
});

test("writes are atomic, private, omit extra credential-shaped fields, and lazily purge expired files", async () => {
	const { cacheDir } = await temporaryCache();
	const unsafeResult = {
		...results(1)[0],
		authorization: "Bearer should-not-be-written",
		apiKey: "should-not-be-written",
	} as SearchResult;
	await writeSearchCache("exa", "private", 5, [unsafeResult], { cacheDir, now: 1_000, ttlMs: 10 });
	const privatePath = getSearchCacheFilePath("exa", "private", { cacheDir });
	const raw = await readFile(privatePath, "utf8");
	assert.doesNotMatch(raw, /authorization|apiKey|should-not-be-written/i);
	assert.equal((await stat(cacheDir)).mode & 0o077, 0);
	assert.equal((await stat(privatePath)).mode & 0o077, 0);
	assert.deepEqual((await readdir(cacheDir)).filter((name) => name.includes(".tmp") || name.endsWith(".lock")), []);

	await writeSearchCache("kagi", "new", 5, results(1), { cacheDir, now: 2_000, ttlMs: 1_000 });
	await purgeExpiredSearchCache({ cacheDir, now: 2_000 });
	await assert.rejects(stat(privatePath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});
