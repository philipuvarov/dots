import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderSearchResponse, SearchProvider, SearchResult } from "./providers.ts";

export type CacheMode = "use" | "refresh" | "off";

export const SEARCH_CACHE_VERSION = 1;
export const DEFAULT_SEARCH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const SEARCH_CACHE_TTL_ENV = "PI_LIGHT_WEB_SEARCH_CACHE_TTL_MS";

const CACHE_DIRECTORY_NAME = "pi-light-web-search";
const LOCK_RETRY_COUNT = 100;
const LOCK_RETRY_MS = 10;
const STALE_ARTIFACT_MS = 60_000;

interface SearchCacheEntry {
	version: typeof SEARCH_CACHE_VERSION;
	provider: SearchProvider;
	createdAt: number;
	expiresAt: number;
	requestedLimit: number;
	results: SearchResult[];
}

export interface SearchCacheOptions {
	cacheDir?: string;
	ttlMs?: number;
	now?: number;
	/** Replace an equally wide entry, used by cacheMode: refresh. */
	replaceEqualLimit?: boolean;
}

export interface SearchCacheMetadata {
	createdAt: number;
	expiresAt: number;
	requestedLimit: number;
	ageMs: number;
}

export interface SearchCacheHit extends SearchCacheMetadata {
	response: ProviderSearchResponse;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function redactKnownCredentials(value: string): string {
	return [process.env.EXA_API_KEY, process.env.KAGI_API_TOKEN, process.env.KAGI_API_KEY].reduce(
		(redacted, secret) => (secret ? redacted.split(secret).join("[redacted]") : redacted),
		value,
	);
}

function normalizeResult(value: unknown): SearchResult | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const title = asNonEmptyString(record.title);
	const url = asNonEmptyString(record.url);
	if (!title || !url || typeof record.snippet !== "string") return undefined;

	const publishedDate = asNonEmptyString(record.publishedDate);
	const source = asNonEmptyString(record.source);
	return {
		title: redactKnownCredentials(title),
		url: redactKnownCredentials(url),
		snippet: redactKnownCredentials(record.snippet),
		...(publishedDate ? { publishedDate: redactKnownCredentials(publishedDate) } : {}),
		...(source ? { source: redactKnownCredentials(source) } : {}),
	};
}

function parseEntry(value: unknown, provider?: SearchProvider): SearchCacheEntry | undefined {
	const record = asRecord(value);
	if (!record || record.version !== SEARCH_CACHE_VERSION) return undefined;
	if (record.provider !== "exa" && record.provider !== "kagi") return undefined;
	if (provider && record.provider !== provider) return undefined;
	if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) return undefined;
	if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return undefined;
	if (record.expiresAt <= record.createdAt) return undefined;
	if (typeof record.requestedLimit !== "number" || !Number.isInteger(record.requestedLimit) || record.requestedLimit < 1) {
		return undefined;
	}
	if (!Array.isArray(record.results) || record.results.length === 0) return undefined;

	const results = record.results.map(normalizeResult);
	if (results.some((result) => result === undefined)) return undefined;
	return {
		version: SEARCH_CACHE_VERSION,
		provider: record.provider,
		createdAt: record.createdAt,
		expiresAt: record.expiresAt,
		requestedLimit: record.requestedLimit,
		results: results as SearchResult[],
	};
}

function currentTime(options: SearchCacheOptions): number {
	return options.now ?? Date.now();
}

export function getSearchCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
	const configured = env[SEARCH_CACHE_TTL_ENV];
	if (configured !== undefined && configured.trim() !== "") {
		const milliseconds = Number(configured);
		if (Number.isFinite(milliseconds) && milliseconds > 0) return milliseconds;
	}

	// Accept an hours-based alias for easier shell configuration.
	const hours = env.PI_LIGHT_WEB_SEARCH_CACHE_TTL_HOURS;
	if (hours !== undefined && hours.trim() !== "") {
		const parsedHours = Number(hours);
		if (Number.isFinite(parsedHours) && parsedHours > 0) return parsedHours * 60 * 60 * 1000;
	}

	return DEFAULT_SEARCH_CACHE_TTL_MS;
}

export function getSearchCacheDirectory(env: NodeJS.ProcessEnv = process.env): string {
	const xdgCacheHome = env.XDG_CACHE_HOME?.trim();
	return join(xdgCacheHome || join(homedir(), ".cache"), CACHE_DIRECTORY_NAME);
}

function cacheDirectory(options: SearchCacheOptions): string {
	return options.cacheDir ?? getSearchCacheDirectory();
}

function cacheHash(provider: SearchProvider, query: string): string {
	return createHash("sha256")
		.update(JSON.stringify({ version: SEARCH_CACHE_VERSION, provider, query }))
		.digest("hex");
}

export function getSearchCacheFilePath(
	provider: SearchProvider,
	query: string,
	options: SearchCacheOptions = {},
): string {
	return join(cacheDirectory(options), `v${SEARCH_CACHE_VERSION}-${cacheHash(provider, query)}.json`);
}

async function removeQuietly(path: string): Promise<void> {
	try {
		await rm(path, { force: true });
	} catch {
		// Cache cleanup must never affect a search.
	}
}

async function readEntryFile(path: string, provider?: SearchProvider): Promise<SearchCacheEntry | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		return parseEntry(JSON.parse(raw), provider);
	} catch {
		return undefined;
	}
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
}

function cacheMetadata(entry: SearchCacheEntry, now: number): SearchCacheMetadata {
	return {
		createdAt: entry.createdAt,
		expiresAt: entry.expiresAt,
		requestedLimit: entry.requestedLimit,
		ageMs: Math.max(0, now - entry.createdAt),
	};
}

export async function readSearchCache(
	provider: SearchProvider,
	query: string,
	numResults: number,
	options: SearchCacheOptions = {},
): Promise<SearchCacheHit | undefined> {
	const path = getSearchCacheFilePath(provider, query, options);
	const entry = await readEntryFile(path, provider);
	if (!entry) {
		// A malformed file is no more useful than a miss. Removal is best effort.
		await removeQuietly(path);
		return undefined;
	}

	const now = currentTime(options);
	if (entry.expiresAt <= now) {
		await removeQuietly(path);
		return undefined;
	}
	if (entry.requestedLimit < numResults) return undefined;

	return {
		...cacheMetadata(entry, now),
		response: {
			provider: entry.provider,
			results: entry.results.slice(0, numResults),
		},
	};
}

async function acquireLock(lockPath: string): Promise<Awaited<ReturnType<typeof open>> | undefined> {
	for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
		try {
			return await open(lockPath, "wx", 0o600);
		} catch (error) {
			const code = asRecord(error)?.code;
			if (code !== "EEXIST") return undefined;

			try {
				const lockStat = await stat(lockPath);
				if (Date.now() - lockStat.mtimeMs > STALE_ARTIFACT_MS) {
					await removeQuietly(lockPath);
					continue;
				}
			} catch {
				continue;
			}
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
	return undefined;
}

export async function purgeExpiredSearchCache(options: SearchCacheOptions = {}): Promise<void> {
	const directory = cacheDirectory(options);
	const now = currentTime(options);
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}

	await Promise.all(
		entries.map(async (directoryEntry) => {
			if (!directoryEntry.isFile()) return;
			const path = join(directory, directoryEntry.name);
			if (/^v\d+-[a-f0-9]{64}\.json$/.test(directoryEntry.name)) {
				const entry = await readEntryFile(path);
				if (!entry || entry.expiresAt <= now) await removeQuietly(path);
				return;
			}

			if (!directoryEntry.name.includes(".tmp") && !directoryEntry.name.endsWith(".lock")) return;
			try {
				const artifactStat = await stat(path);
				if (now - artifactStat.mtimeMs > STALE_ARTIFACT_MS) await removeQuietly(path);
			} catch {
				// Another process may already have removed it.
			}
		}),
	);
}

export async function writeSearchCache(
	provider: SearchProvider,
	query: string,
	requestedLimit: number,
	results: SearchResult[],
	options: SearchCacheOptions = {},
): Promise<SearchCacheMetadata | undefined> {
	const normalizedResults = results.flatMap((result) => {
		const normalized = normalizeResult(result);
		return normalized ? [normalized] : [];
	});
	if (normalizedResults.length === 0) return undefined;

	const directory = cacheDirectory(options);
	const path = getSearchCacheFilePath(provider, query, options);
	const lockPath = `${path}.lock`;
	const now = currentTime(options);
	const ttlMs = options.ttlMs ?? getSearchCacheTtlMs();
	if (!Number.isFinite(ttlMs) || ttlMs <= 0) return undefined;

	let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
	let temporaryPath: string | undefined;
	try {
		await ensurePrivateDirectory(directory);
		await purgeExpiredSearchCache(options);
		lockHandle = await acquireLock(lockPath);
		if (!lockHandle) return undefined;

		const existing = await readEntryFile(path, provider);
		if (
			existing &&
			existing.expiresAt > now &&
			(existing.requestedLimit > requestedLimit ||
				(!options.replaceEqualLimit &&
					existing.requestedLimit === requestedLimit &&
					existing.results.length >= normalizedResults.length))
		) {
			return cacheMetadata(existing, now);
		}

		const entry: SearchCacheEntry = {
			version: SEARCH_CACHE_VERSION,
			provider,
			createdAt: now,
			expiresAt: now + ttlMs,
			requestedLimit,
			results: normalizedResults,
		};
		temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await chmod(temporaryPath, 0o600);
		await rename(temporaryPath, path);
		temporaryPath = undefined;
		await chmod(path, 0o600);
		return cacheMetadata(entry, now);
	} catch {
		return undefined;
	} finally {
		if (temporaryPath) await removeQuietly(temporaryPath);
		try {
			await lockHandle?.close();
		} catch {
			// Ignore close failures for a disposable cache lock.
		}
		if (lockHandle) await removeQuietly(lockPath);
	}
}
