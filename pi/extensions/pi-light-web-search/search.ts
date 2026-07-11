import {
	type CacheMode,
	type SearchCacheHit,
	type SearchCacheMetadata,
	type SearchCacheOptions,
	readSearchCache,
	writeSearchCache,
} from "./cache.ts";
import {
	type ProviderSearchResponse,
	type SearchProvider,
	type SearchResult,
	searchExa,
	searchKagi,
} from "./providers.ts";

export type RequestedProvider = "auto" | SearchProvider;

export interface WebSearchCacheDetails {
	mode: CacheMode;
	hit: boolean;
	provider?: SearchProvider;
	ageMs?: number;
	createdAt?: number;
	expiresAt?: number;
	requestedLimit?: number;
}

export interface SearchExecutionDetails {
	query: string;
	numResults: number;
	requestedProvider: RequestedProvider;
	attemptedProviders: SearchProvider[];
	fallbackReason?: string;
	cache: WebSearchCacheDetails;
}

export interface SearchExecutionResult {
	response: ProviderSearchResponse;
	details: SearchExecutionDetails;
}

type SearchFunction = (
	query: string,
	numResults: number,
	credential: string,
	signal?: AbortSignal,
) => Promise<ProviderSearchResponse>;

type ReadCacheFunction = typeof readSearchCache;
type WriteCacheFunction = typeof writeSearchCache;

export interface SearchDependencies {
	env?: NodeJS.ProcessEnv;
	searchExa?: SearchFunction;
	searchKagi?: SearchFunction;
	readCache?: ReadCacheFunction;
	writeCache?: WriteCacheFunction;
	cacheOptions?: SearchCacheOptions;
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new DOMException("The operation was aborted", "AbortError");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function redact(value: string, secrets: Array<string | undefined>): string {
	return secrets.reduce((redacted, secret) => (secret ? redacted.split(secret).join("[redacted]") : redacted), value);
}

function redactResult(result: SearchResult, secrets: Array<string | undefined>): SearchResult {
	return {
		title: redact(result.title, secrets),
		url: redact(result.url, secrets),
		snippet: redact(result.snippet, secrets),
		...(result.publishedDate ? { publishedDate: redact(result.publishedDate, secrets) } : {}),
		...(result.source ? { source: redact(result.source, secrets) } : {}),
	};
}

function sanitizeResponse(
	response: ProviderSearchResponse,
	provider: SearchProvider,
	numResults: number,
	secrets: Array<string | undefined>,
): ProviderSearchResponse {
	return {
		provider,
		results: response.results.slice(0, numResults).map((result) => redactResult(result, secrets)),
	};
}

function hitCacheDetails(mode: CacheMode, hit: SearchCacheHit): WebSearchCacheDetails {
	return {
		mode,
		hit: true,
		provider: hit.response.provider,
		ageMs: hit.ageMs,
		createdAt: hit.createdAt,
		expiresAt: hit.expiresAt,
		requestedLimit: hit.requestedLimit,
	};
}

function missCacheDetails(
	mode: CacheMode,
	provider?: SearchProvider,
	metadata?: SearchCacheMetadata,
): WebSearchCacheDetails {
	return {
		mode,
		hit: false,
		...(provider ? { provider } : {}),
		...(metadata
			? {
					ageMs: metadata.ageMs,
					createdAt: metadata.createdAt,
					expiresAt: metadata.expiresAt,
					requestedLimit: metadata.requestedLimit,
				}
			: {}),
	};
}

async function safeReadCache(
	readCache: ReadCacheFunction,
	provider: SearchProvider,
	query: string,
	numResults: number,
	options?: SearchCacheOptions,
): Promise<SearchCacheHit | undefined> {
	try {
		return await readCache(provider, query, numResults, options);
	} catch {
		return undefined;
	}
}

async function safeWriteCache(
	writeCache: WriteCacheFunction,
	provider: SearchProvider,
	query: string,
	numResults: number,
	results: SearchResult[],
	options?: SearchCacheOptions,
): Promise<SearchCacheMetadata | undefined> {
	try {
		return await writeCache(provider, query, numResults, results, options);
	} catch {
		return undefined;
	}
}

async function finishLiveResponse(
	response: ProviderSearchResponse,
	provider: SearchProvider,
	query: string,
	numResults: number,
	cacheMode: CacheMode,
	baseDetails: Omit<SearchExecutionDetails, "cache">,
	writeCache: WriteCacheFunction,
	cacheOptions: SearchCacheOptions | undefined,
	secrets: Array<string | undefined>,
): Promise<SearchExecutionResult> {
	const sanitized = sanitizeResponse(response, provider, numResults, secrets);
	const writeOptions =
		cacheMode === "refresh" ? { ...cacheOptions, replaceEqualLimit: true } : cacheOptions;
	const metadata =
		cacheMode !== "off" && sanitized.results.length > 0
			? await safeWriteCache(writeCache, provider, query, numResults, sanitized.results, writeOptions)
			: undefined;
	return {
		response: sanitized,
		details: {
			...baseDetails,
			cache: missCacheDetails(cacheMode, provider, metadata),
		},
	};
}

export async function executeSearch(
	query: string,
	numResults: number,
	provider: RequestedProvider,
	cacheMode: CacheMode = "use",
	signal?: AbortSignal,
	dependencies: SearchDependencies = {},
): Promise<SearchExecutionResult> {
	throwIfAborted(signal);

	const env = dependencies.env ?? process.env;
	const exaApiKey = env.EXA_API_KEY;
	const kagiToken = env.KAGI_API_TOKEN;
	const runExa = dependencies.searchExa ?? searchExa;
	const runKagi = dependencies.searchKagi ?? searchKagi;
	const readCache = dependencies.readCache ?? readSearchCache;
	const writeCache = dependencies.writeCache ?? writeSearchCache;
	const cacheOptions = dependencies.cacheOptions;
	const secrets = [exaApiKey, kagiToken];
	const attemptedProviders: SearchProvider[] = [];
	const baseDetails: Omit<SearchExecutionDetails, "cache" | "fallbackReason"> = {
		query: redact(query, secrets),
		numResults,
		requestedProvider: provider,
		attemptedProviders,
	};

	if (provider !== "auto") {
		if (cacheMode === "use") {
			const hit = await safeReadCache(readCache, provider, query, numResults, cacheOptions);
			throwIfAborted(signal);
			if (hit) {
				return {
					response: sanitizeResponse(hit.response, provider, numResults, secrets),
					details: { ...baseDetails, cache: hitCacheDetails(cacheMode, hit) },
				};
			}
		}

		const credential = provider === "exa" ? exaApiKey : kagiToken;
		if (!credential) {
			throw new Error(
				provider === "exa"
					? "Exa search requested, but EXA_API_KEY is not set and no usable cache entry was found."
					: "Kagi search requested, but KAGI_API_TOKEN is not set and no usable cache entry was found.",
			);
		}

		attemptedProviders.push(provider);
		try {
			const response = await (provider === "exa" ? runExa : runKagi)(query, numResults, credential, signal);
			throwIfAborted(signal);
			return await finishLiveResponse(
				response,
				provider,
				query,
				numResults,
				cacheMode,
				baseDetails,
				writeCache,
				cacheOptions,
				secrets,
			);
		} catch (error) {
			if (isAbortError(error, signal)) throw error;
			throw new Error(redact(errorMessage(error), secrets));
		}
	}

	if (cacheMode === "use") {
		// Check both providers before spending either provider's credits.
		const [exaHit, kagiHit] = await Promise.all([
			safeReadCache(readCache, "exa", query, numResults, cacheOptions),
			safeReadCache(readCache, "kagi", query, numResults, cacheOptions),
		]);
		throwIfAborted(signal);
		const hit = exaHit ?? kagiHit;
		if (hit) {
			return {
				response: sanitizeResponse(hit.response, hit.response.provider, numResults, secrets),
				details: { ...baseDetails, cache: hitCacheDetails(cacheMode, hit) },
			};
		}
	}

	const reasons: string[] = [];
	let emptyResponse: { response: ProviderSearchResponse; provider: SearchProvider } | undefined;
	const liveProviders: Array<{
		provider: SearchProvider;
		credential?: string;
		missingReason: string;
		search: SearchFunction;
	}> = [
		{
			provider: "exa",
			credential: exaApiKey,
			missingReason: "EXA_API_KEY is not set.",
			search: runExa,
		},
		{
			provider: "kagi",
			credential: kagiToken,
			missingReason: "KAGI_API_TOKEN is not set.",
			search: runKagi,
		},
	];

	for (const live of liveProviders) {
		throwIfAborted(signal);
		if (!live.credential) {
			reasons.push(`${live.provider === "exa" ? "Exa" : "Kagi"}: ${live.missingReason}`);
			continue;
		}

		attemptedProviders.push(live.provider);
		try {
			const rawResponse = await live.search(query, numResults, live.credential, signal);
			throwIfAborted(signal);
			const response = sanitizeResponse(rawResponse, live.provider, numResults, secrets);
			if (response.results.length > 0) {
				const fallbackReason = reasons.length > 0 ? reasons.join("; ") : undefined;
				return await finishLiveResponse(
					response,
					live.provider,
					query,
					numResults,
					cacheMode,
					{ ...baseDetails, ...(fallbackReason ? { fallbackReason } : {}) },
					writeCache,
					cacheOptions,
					secrets,
				);
			}

			emptyResponse = { response, provider: live.provider };
			reasons.push(`${live.provider === "exa" ? "Exa" : "Kagi"}: returned no results.`);
		} catch (error) {
			if (isAbortError(error, signal)) throw error;
			const providerLabel = live.provider === "exa" ? "Exa" : "Kagi";
			reasons.push(`${providerLabel}: ${redact(errorMessage(error), secrets)}`);
		}
	}

	if (emptyResponse) {
		return finishLiveResponse(
			emptyResponse.response,
			emptyResponse.provider,
			query,
			numResults,
			cacheMode,
			{ ...baseDetails, fallbackReason: reasons.join("; ") },
			writeCache,
			cacheOptions,
			secrets,
		);
	}

	throw new Error(`web_search auto provider failed. ${reasons.join("; ")}`);
}
