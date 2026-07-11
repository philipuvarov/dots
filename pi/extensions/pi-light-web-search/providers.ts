export type SearchProvider = "exa" | "kagi";
export type FetchProvider = "kagi" | "direct";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	publishedDate?: string;
	source?: string;
}

export interface ProviderSearchResponse {
	provider: SearchProvider;
	results: SearchResult[];
}

export interface ProviderFetchResponse {
	provider: FetchProvider;
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	contentLength: number;
	truncated: boolean;
	markdown?: string;
	text?: string;
	warning?: string;
}

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const KAGI_SEARCH_URL = "https://kagi.com/api/v1/search";
const KAGI_EXTRACT_URL = "https://kagi.com/api/v1/extract";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stripHtml(value: string): string {
	return value
		.replace(/<[^>]*>/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.replace(/\s+([,.;:!?])/g, "$1")
		.trim();
}

function sourceFromUrl(url: string): string | undefined {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return undefined;
	}
}

function truncate(value: string, maxLength = 300): string {
	return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function redact(value: string, secret?: string): string {
	if (!secret) return value;
	return value.split(secret).join("[redacted]");
}

function truncateToMax(value: string, maxChars: number): { value: string; truncated: boolean; originalLength: number } {
	return {
		value: value.length > maxChars ? value.slice(0, maxChars) : value,
		truncated: value.length > maxChars,
		originalLength: value.length,
	};
}

function errorMessages(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(errorMessages);

	const direct = asString(value);
	if (direct) return [direct];

	const record = asRecord(value);
	if (!record) return [];
	const message = asString(record.message) ?? asString(record.msg) ?? asString(record.detail);
	if (message) return [message];
	return record.error === value ? [] : errorMessages(record.error);
}

function formatProviderError(providerName: string, status: number, json: unknown, text: string, secret?: string): string {
	const record = asRecord(json);
	const messages = [...errorMessages(record?.errors), ...errorMessages(record?.error)];
	const traceRecord = asRecord(record?.meta);
	const trace = asString(traceRecord?.trace) ?? asString(traceRecord?.id);
	const requestId = asString(record?.requestId) ?? asString(record?.request_id);
	const tag = asString(record?.tag);
	const rawDetail = messages.length > 0 ? truncate(messages.join("; ")) : text.trim() ? truncate(stripHtml(text)) : "";
	const detail = rawDetail ? redact(stripHtml(rawDetail), secret) : "";
	const tagDetail = tag ? ` [tag: ${redact(tag, secret)}]` : "";
	const requestDetail = requestId ? ` (requestId: ${redact(requestId, secret)})` : trace ? ` (trace: ${redact(trace, secret)})` : "";
	return redact(
		`${providerName} returned HTTP ${status}${detail ? `: ${detail}` : ""}${tagDetail}${requestDetail}`,
		secret,
	);
}

function isAbortError(error: unknown, signal?: AbortSignal | null): boolean {
	return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

async function fetchJson(url: string, init: RequestInit, providerName: string, secret?: string): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (error) {
		if (isAbortError(error, init.signal)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${providerName} request failed: ${redact(message, secret)}`);
	}

	const text = await response.text();
	let json: unknown = undefined;
	if (text.trim().length > 0) {
		try {
			json = JSON.parse(text);
		} catch {
			if (response.ok) {
				throw new Error(`${providerName} returned non-JSON response`);
			}
		}
	}

	if (!response.ok) {
		throw new Error(formatProviderError(providerName, response.status, json, text, secret));
	}

	return json;
}

function redactSearchResult(result: SearchResult, secret: string): SearchResult {
	return {
		title: redact(result.title, secret),
		url: redact(result.url, secret),
		snippet: redact(result.snippet, secret),
		...(result.publishedDate ? { publishedDate: redact(result.publishedDate, secret) } : {}),
		...(result.source ? { source: redact(result.source, secret) } : {}),
	};
}

function normalizeExaResult(item: unknown): SearchResult | undefined {
	const record = asRecord(item);
	if (!record) return undefined;

	const url = asString(record.url);
	const title = asString(record.title);
	if (!url || !title) return undefined;

	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
	} catch {
		return undefined;
	}

	const highlights = Array.isArray(record.highlights)
		? record.highlights.flatMap((highlight) => {
				const text = asString(highlight);
				return text ? [stripHtml(text)] : [];
			})
		: [];
	const fallbackSnippet = asString(record.summary) ?? asString(record.text) ?? asString(record.snippet) ?? "";
	const snippet = truncate(highlights.length > 0 ? highlights.join(" … ") : stripHtml(fallbackSnippet));
	const publishedDate =
		asString(record.publishedDate) ?? asString(record.published_date) ?? asString(record.published) ?? asString(record.date);
	const source = sourceFromUrl(url);

	return {
		title: stripHtml(title),
		url,
		snippet,
		...(publishedDate ? { publishedDate } : {}),
		...(source ? { source } : {}),
	};
}

export async function searchExa(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<ProviderSearchResponse> {
	const json = await fetchJson(
		EXA_SEARCH_URL,
		{
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"x-api-key": apiKey,
			},
			body: JSON.stringify({
				query,
				numResults,
				type: "auto",
				contents: { highlights: true },
			}),
			signal,
		},
		"Exa",
		apiKey,
	);

	const record = asRecord(json);
	const items = Array.isArray(record?.results) ? record.results : [];
	const results = items.flatMap((item) => {
		const result = normalizeExaResult(item);
		return result ? [redactSearchResult(result, apiKey)] : [];
	});

	return {
		provider: "exa",
		results: results.slice(0, numResults),
	};
}

function normalizeKagiResult(item: unknown): SearchResult | undefined {
	const record = asRecord(item);
	if (!record) return undefined;

	const url = asString(record.url);
	const title = asString(record.title) ?? asString(record.name);
	if (!url || !title) return undefined;

	const rawSnippet =
		asString(record.snippet) ?? asString(record.description) ?? asString(record.text) ?? asString(record.content) ?? "";
	const snippet = stripHtml(rawSnippet);
	const publishedDate =
		asString(record.time) ??
		asString(record.published) ??
		asString(record.publishedDate) ??
		asString(record.date) ??
		asString(record.updated);

	return {
		title: stripHtml(title),
		url,
		snippet,
		...(publishedDate ? { publishedDate } : {}),
		...(sourceFromUrl(url) ? { source: sourceFromUrl(url) } : {}),
	};
}

export async function searchKagi(
	query: string,
	numResults: number,
	token: string,
	signal?: AbortSignal,
): Promise<ProviderSearchResponse> {
	const json = await fetchJson(
		KAGI_SEARCH_URL,
		{
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query,
				limit: numResults,
			}),
			signal,
		},
		"Kagi",
		token,
	);

	const record = asRecord(json);
	const data = asRecord(record?.data);
	const items = Array.isArray(data?.search)
		? data.search
		: Array.isArray(record?.data)
			? record.data
			: Array.isArray(json)
				? json
				: [];
	const results = items.flatMap((item) => {
		const result = normalizeKagiResult(item);
		return result ? [redactSearchResult(result, token)] : [];
	});

	return {
		provider: "kagi",
		results: results.slice(0, numResults),
	};
}

function extractKagiDataItem(json: unknown): Record<string, unknown> | undefined {
	const record = asRecord(json);
	const data = Array.isArray(record?.data) ? record.data : Array.isArray(json) ? json : [];
	return asRecord(data[0]);
}

function kagiExtractError(item: Record<string, unknown>): string | undefined {
	const error = item.error;
	const errorRecord = asRecord(error);
	return (
		asString(error) ??
		asString(errorRecord?.message) ??
		asString(errorRecord?.msg) ??
		asString(errorRecord?.detail) ??
		(error ? JSON.stringify(error) : undefined)
	);
}

export async function fetchKagiExtract(
	url: string,
	maxChars: number,
	token: string,
	signal?: AbortSignal,
): Promise<ProviderFetchResponse> {
	let response: Response;
	try {
		response = await fetch(KAGI_EXTRACT_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				pages: [{ url }],
			}),
			signal,
		});
	} catch (error) {
		if (isAbortError(error, signal)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Kagi Extract request failed: ${redact(message, token)}`);
	}

	const text = await response.text();
	let json: unknown = undefined;
	if (text.trim().length > 0) {
		try {
			json = JSON.parse(text);
		} catch {
			if (response.ok) {
				throw new Error("Kagi Extract returned non-JSON response");
			}
		}
	}

	if (!response.ok) {
		throw new Error(formatProviderError("Kagi Extract", response.status, json, text, token));
	}

	const item = extractKagiDataItem(json);
	if (!item) {
		throw new Error("Kagi Extract returned no data for the requested URL.");
	}

	const itemError = kagiExtractError(item);
	if (itemError) {
		throw new Error(`Kagi Extract returned an error for the requested URL: ${redact(itemError, token)}`);
	}

	const markdown = asString(item.markdown) ?? asString(item.content) ?? asString(item.text);
	if (!markdown) {
		throw new Error("Kagi Extract returned no markdown content for the requested URL.");
	}

	const truncated = truncateToMax(markdown, maxChars);
	const finalUrl =
		asString(item.finalUrl) ??
		asString(item.final_url) ??
		asString(item.resolvedUrl) ??
		asString(item.url) ??
		url;

	return {
		provider: "kagi",
		url,
		finalUrl,
		status: response.status,
		contentType: "text/markdown",
		contentLength: truncated.originalLength,
		truncated: truncated.truncated,
		markdown: truncated.value,
	};
}

function decodeCommonHtmlEntities(value: string): string {
	const namedEntities: Record<string, string> = {
		amp: "&",
		apos: "'",
		copy: "(c)",
		gt: ">",
		hellip: "...",
		laquo: "<<",
		ldquo: '"',
		lsquo: "'",
		lt: "<",
		mdash: "-",
		ndash: "-",
		nbsp: " ",
		quot: '"',
		raquo: ">>",
		rdquo: '"',
		reg: "(r)",
		rsquo: "'",
	};

	return value
		.replace(/&#(\d+);/g, (match, codePointText: string) => {
			const codePoint = Number.parseInt(codePointText, 10);
			if (!Number.isFinite(codePoint)) return match;
			try {
				return String.fromCodePoint(codePoint);
			} catch {
				return match;
			}
		})
		.replace(/&#x([0-9a-f]+);/gi, (match, codePointText: string) => {
			const codePoint = Number.parseInt(codePointText, 16);
			if (!Number.isFinite(codePoint)) return match;
			try {
				return String.fromCodePoint(codePoint);
			} catch {
				return match;
			}
		})
		.replace(/&([a-z]+);/gi, (match, entityName: string) => namedEntities[entityName.toLowerCase()] ?? match);
}

function normalizeHtmlText(value: string): string {
	return value
		.replace(/\u00a0/g, " ")
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/\s*\n\s*/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function extractHtmlTitle(html: string): string | undefined {
	const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
	if (!titleMatch) return undefined;

	const title = normalizeHtmlText(decodeCommonHtmlEntities(titleMatch[1].replace(/<[^>]*>/g, " ")));
	return title.length > 0 ? title : undefined;
}

function htmlToText(html: string): string {
	return normalizeHtmlText(
		decodeCommonHtmlEntities(
			html
				.replace(/<!--[\s\S]*?-->/g, " ")
				.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
				.replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, " ")
				.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
				.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
				.replace(/<(br|hr)\b[^>]*>/gi, "\n")
				.replace(/<\/(article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|td|th|tr|ul)>/gi, "\n")
				.replace(/<[^>]*>/g, " "),
		),
	);
}

function htmlToReadableText(html: string): string {
	const title = extractHtmlTitle(html);
	const bodyText = htmlToText(html);
	if (!title) return bodyText;
	if (!bodyText) return `Title: ${title}`;
	return `Title: ${title}\n\n${bodyText}`;
}

type DirectContentKind = "html" | "json" | "text";

function directContentKind(contentType: string): DirectContentKind | undefined {
	const mediaType = contentType.split(";")[0].trim().toLowerCase();
	if (mediaType === "text/html") return "html";
	if (mediaType === "text/plain") return "text";
	if (mediaType === "application/json" || mediaType.endsWith("+json")) return "json";
	return undefined;
}

function formatJsonText(value: string): string {
	try {
		return JSON.stringify(JSON.parse(value), null, 2);
	} catch {
		return value;
	}
}

export async function fetchDirect(url: string, maxChars: number, signal?: AbortSignal): Promise<ProviderFetchResponse> {
	let response: Response;
	try {
		response = await fetch(url, {
			headers: {
				Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.1",
			},
			signal,
		});
	} catch (error) {
		if (isAbortError(error, signal)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Direct fetch request failed: ${message}`);
	}

	const contentType = response.headers.get("content-type") ?? "";
	const kind = directContentKind(contentType);
	if (!kind) {
		const displayType = contentType || "unknown content type";
		throw new Error(
			`Direct fetch does not support ${displayType}. Supported content types are text/html, text/plain, application/json, and +json.`,
		);
	}

	if (!response.ok) {
		throw new Error(`Direct fetch returned HTTP ${response.status} for ${response.url}`);
	}

	const rawText = await response.text();
	const readableText =
		kind === "html" ? htmlToReadableText(rawText) : kind === "json" ? formatJsonText(rawText) : rawText;
	const truncated = truncateToMax(readableText, maxChars);

	return {
		provider: "direct",
		url,
		finalUrl: response.url || url,
		status: response.status,
		contentType,
		contentLength: truncated.originalLength,
		truncated: truncated.truncated,
		text: truncated.value,
	};
}
