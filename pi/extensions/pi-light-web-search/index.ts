import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CacheMode } from "./cache.ts";
import {
	type FetchProvider,
	type ProviderFetchResponse,
	type SearchProvider,
	type SearchResult,
	fetchDirect,
	fetchKagiExtract,
} from "./providers.ts";
import {
	type RequestedProvider,
	type SearchExecutionDetails,
	type SearchExecutionResult,
	executeSearch,
	isAbortError,
	throwIfAborted,
} from "./search.ts";

type RequestedFetchProvider = "auto" | FetchProvider;

export interface WebSearchDetails extends SearchExecutionDetails {
	providerUsed?: SearchProvider;
	results: SearchResult[];
}

export interface WebFetchDetails {
	url: string;
	finalUrl: string;
	providerUsed?: FetchProvider;
	requestedProvider: RequestedFetchProvider;
	status: number;
	contentType: string;
	contentLength: number;
	truncated: boolean;
	markdown?: string;
	text?: string;
	warning?: string;
	fallbackReason?: string;
}

const WebSearchParams = Type.Object({
	query: Type.String({
		description: "Search query. Must contain non-whitespace text.",
		minLength: 1,
	}),
	numResults: Type.Optional(
		Type.Number({
			description: "Maximum number of results to return. Defaults to 5 and is clamped from 1 to 10.",
			default: 5,
		}),
	),
	provider: Type.Optional(
		StringEnum(["auto", "exa", "kagi"] as const, {
			description: "Search provider. auto checks cache, then uses Exa with Kagi as the live fallback.",
			default: "auto",
		}),
	),
	cacheMode: Type.Optional(
		StringEnum(["use", "refresh", "off"] as const, {
			description: "Cache behavior. use reads and writes cache, refresh skips reads, and off disables cache.",
			default: "use",
		}),
	),
});

const WebFetchParams = Type.Object({
	url: Type.String({
		description: "Absolute http: or https: URL to fetch.",
		minLength: 1,
	}),
	maxChars: Type.Optional(
		Type.Number({
			description: "Maximum number of readable content characters to return. Defaults to 12000 and is clamped from 1 to 50000.",
			default: 12000,
		}),
	),
	provider: Type.Optional(
		StringEnum(["auto", "kagi", "direct"] as const, {
			description:
				"Fetch provider. auto uses Kagi Extract when KAGI_API_TOKEN or KAGI_API_KEY is set, otherwise direct HTTP fallback.",
			default: "auto",
		}),
	),
});

function clampNumResults(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.min(10, Math.max(1, Math.trunc(value)));
}

function clampMaxChars(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 12000;
	return Math.min(50000, Math.max(1, Math.trunc(value)));
}

function providerLabel(provider: SearchProvider): string {
	return provider === "exa" ? "Exa" : "Kagi";
}

function formatAge(ageMs: number): string {
	if (ageMs < 1000) return "less than a second";
	if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s`;
	if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`;
	return `${Math.floor(ageMs / 3_600_000)}h`;
}

function formatCacheStatus(details: SearchExecutionDetails): string {
	const cache = details.cache;
	if (cache.mode === "off") return "Cache: off";
	if (cache.hit) {
		const age = cache.ageMs === undefined ? "unknown age" : formatAge(cache.ageMs);
		const expiration = cache.expiresAt === undefined ? "" : `; expires ${new Date(cache.expiresAt).toISOString()}`;
		return `Cache: hit (${age}${expiration})`;
	}
	if (cache.expiresAt !== undefined) {
		const action = cache.mode === "refresh" ? "refreshed" : "miss; live results stored";
		return `Cache: ${action} until ${new Date(cache.expiresAt).toISOString()}`;
	}
	return cache.mode === "refresh" ? "Cache: refresh; no entry stored" : "Cache: miss";
}

function formatResults(execution: SearchExecutionResult): AgentToolResult<WebSearchDetails> {
	const { response, details } = execution;
	const cachedLabel = details.cache.hit ? " (cached)" : "";
	const header = `Web search results for "${details.query}" via ${providerLabel(response.provider)}${cachedLabel}`;
	const lines: string[] = [header, formatCacheStatus(details)];

	if (details.fallbackReason) {
		lines.push(`Fallback diagnostics: ${details.fallbackReason}`);
	}

	if (response.results.length === 0) {
		lines.push("", "No results found.");
	} else {
		lines.push(
			"",
			...response.results.flatMap((result, index) => {
				const resultLines = [`${index + 1}. ${result.title}`, `   URL: ${result.url}`];
				if (result.snippet) resultLines.push(`   Snippet: ${result.snippet}`);
				if (result.publishedDate) resultLines.push(`   Published: ${result.publishedDate}`);
				if (result.source) resultLines.push(`   Source: ${result.source}`);
				resultLines.push(`   Provider: ${response.provider}`);
				return index === response.results.length - 1 ? resultLines : [...resultLines, ""];
			}),
		);
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			...details,
			providerUsed: response.provider,
			results: response.results,
		},
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseFetchUrl(value: string): string {
	const trimmed = value.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error("web_fetch url must be an absolute http: or https: URL.");
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("web_fetch url must use the http: or https: protocol.");
	}

	return url.toString();
}

function getKagiFetchToken(): string | undefined {
	return process.env.KAGI_API_TOKEN || process.env.KAGI_API_KEY;
}

interface FetchFormatDetails {
	url: string;
	requestedProvider: RequestedFetchProvider;
	fallbackReason?: string;
}

function formatFetchResult(
	response: ProviderFetchResponse,
	details: FetchFormatDetails,
): AgentToolResult<WebFetchDetails> {
	const fetchProviderLabel = response.provider === "kagi" ? "Kagi Extract" : "direct HTTP";
	const lines = [`Fetched ${response.finalUrl} via ${fetchProviderLabel}`];

	lines.push(`Status: ${response.status}`);
	lines.push(`Content-Type: ${response.contentType}`);
	lines.push(`Content length: ${response.contentLength} characters`);

	if (response.truncated) {
		lines.push("Truncated: true");
	}

	if (details.fallbackReason) {
		lines.push(`Fallback reason: ${details.fallbackReason}`);
	}

	if (response.warning) {
		lines.push(`Warning: ${response.warning}`);
	}

	const readableContent = response.markdown ?? response.text ?? "";
	lines.push("", readableContent || "No readable content extracted.");

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			...details,
			finalUrl: response.finalUrl,
			providerUsed: response.provider,
			status: response.status,
			contentType: response.contentType,
			contentLength: response.contentLength,
			truncated: response.truncated,
			...(response.markdown !== undefined ? { markdown: response.markdown } : {}),
			...(response.text !== undefined ? { text: response.text } : {}),
			...(response.warning ? { warning: response.warning } : {}),
		},
	};
}

async function executeFetch(
	url: string,
	maxChars: number,
	provider: RequestedFetchProvider,
	signal?: AbortSignal,
): Promise<AgentToolResult<WebFetchDetails>> {
	throwIfAborted(signal);
	const baseDetails = {
		url,
		requestedProvider: provider,
	};

	if (provider === "direct") {
		const response = await fetchDirect(url, maxChars, signal);
		return formatFetchResult(response, baseDetails);
	}

	const kagiToken = getKagiFetchToken();
	if (provider === "kagi") {
		if (!kagiToken) {
			throw new Error("Kagi fetch requested, but neither KAGI_API_TOKEN nor KAGI_API_KEY is set.");
		}
		const response = await fetchKagiExtract(url, maxChars, kagiToken, signal);
		return formatFetchResult(response, baseDetails);
	}

	let fallbackReason = "";
	if (kagiToken) {
		try {
			const response = await fetchKagiExtract(url, maxChars, kagiToken, signal);
			throwIfAborted(signal);
			return formatFetchResult(response, baseDetails);
		} catch (error) {
			if (isAbortError(error, signal)) throw error;
			fallbackReason = errorMessage(error);
		}
	} else {
		fallbackReason = "Neither KAGI_API_TOKEN nor KAGI_API_KEY is set.";
	}

	throwIfAborted(signal);
	try {
		const response = await fetchDirect(url, maxChars, signal);
		return formatFetchResult(response, {
			...baseDetails,
			fallbackReason,
		});
	} catch (error) {
		if (isAbortError(error, signal)) throw error;
		throw new Error(
			`web_fetch auto provider failed. Kagi fallback reason: ${fallbackReason}. Direct error: ${errorMessage(error)}`,
		);
	}
}

export const webSearchTool = defineTool<typeof WebSearchParams, WebSearchDetails>({
	name: "web_search",
	label: "Web Search (Exa/Kagi)",
	description:
		"Search the web for current information. Checks a local cache, then uses Exa with Kagi as the auto-provider fallback.",
	promptSnippet: "Search the web for current information with persistent local caching",
	promptGuidelines: [
		"Use web_search to discover URLs and current result metadata.",
		"Use web_fetch when you need readable contents from a known URL.",
		"Use web_search provider auto unless the user specifically requests Exa or Kagi.",
		"Use web_search cacheMode refresh when the user needs results newer than the local cache.",
	],
	parameters: WebSearchParams,
	async execute(_toolCallId, params, signal) {
		const query = params.query.trim();
		if (!query) {
			throw new Error("web_search query must contain non-whitespace text.");
		}

		const numResults = clampNumResults(params.numResults);
		const provider: RequestedProvider = params.provider ?? "auto";
		const cacheMode: CacheMode = params.cacheMode ?? "use";
		return formatResults(await executeSearch(query, numResults, provider, cacheMode, signal));
	},
});

export const webFetchTool = defineTool<typeof WebFetchParams, WebFetchDetails>({
	name: "web_fetch",
	label: "Web Fetch",
	description:
		"Fetch readable content from a known URL. Uses Kagi Extract when available, with direct HTTP fallback for HTML, plain text, and JSON.",
	promptSnippet: "Fetch readable contents from a known URL",
	promptGuidelines: [
		"Use web_fetch to read the contents of a known absolute http: or https: URL.",
		"Use web_search first when you need to discover URLs or compare current result metadata.",
		"Use web_fetch provider auto unless the user specifically asks for Kagi Extract or direct HTTP fetching.",
		"Direct HTTP fetching supports HTML, plain text, and JSON only; PDFs and binary content are rejected.",
	],
	parameters: WebFetchParams,
	async execute(_toolCallId, params, signal) {
		const url = parseFetchUrl(params.url);
		const maxChars = clampMaxChars(params.maxChars);
		const provider = params.provider ?? "auto";
		return executeFetch(url, maxChars, provider, signal);
	},
});

export default function piLightWebSearch(pi: ExtensionAPI) {
	pi.registerTool(webSearchTool);
	pi.registerTool(webFetchTool);
}
