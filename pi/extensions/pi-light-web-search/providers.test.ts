import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { searchExa, searchKagi } from "./providers.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("searchExa uses the Exa endpoint, headers, and request body", async () => {
	let requestedUrl = "";
	let requestedInit: RequestInit | undefined;
	globalThis.fetch = async (url, init) => {
		requestedUrl = String(url);
		requestedInit = init;
		return new Response(JSON.stringify({ results: [] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};

	await searchExa("current TypeScript release", 7, "exa-secret");

	assert.equal(requestedUrl, "https://api.exa.ai/search");
	assert.equal(requestedInit?.method, "POST");
	const headers = new Headers(requestedInit?.headers);
	assert.equal(headers.get("x-api-key"), "exa-secret");
	assert.equal(headers.get("content-type"), "application/json");
	assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
		query: "current TypeScript release",
		numResults: 7,
		type: "auto",
		contents: { highlights: true },
	});
});

test("searchExa normalizes highlights and metadata", async () => {
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				results: [
					{
						title: "<b>Example</b> result",
						url: "https://www.example.com/article",
						highlights: ["First <em>highlight</em>.", "Second &amp; final."],
						publishedDate: "2026-07-10T12:00:00.000Z",
					},
					{
						title: "Summary fallback",
						url: "https://news.example.org/story",
						highlights: [],
						summary: "A defensive summary.",
					},
				],
			}),
			{ status: 200 },
		);

	const response = await searchExa("example", 5, "key");
	assert.deepEqual(response, {
		provider: "exa",
		results: [
			{
				title: "Example result",
				url: "https://www.example.com/article",
				snippet: "First highlight. … Second & final.",
				publishedDate: "2026-07-10T12:00:00.000Z",
				source: "example.com",
			},
			{
				title: "Summary fallback",
				url: "https://news.example.org/story",
				snippet: "A defensive summary.",
				source: "news.example.org",
			},
		],
	});
});

test("searchExa filters malformed results and falls back to text", async () => {
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				results: [
					{ title: "No URL", highlights: ["ignored"] },
					{ title: "Bad URL", url: "javascript:alert(1)" },
					{ url: "https://example.com/no-title" },
					null,
					{ title: "Valid", url: "https://example.com/valid", text: "Fallback <b>text</b>." },
				],
			}),
			{ status: 200 },
		);

	const response = await searchExa("valid", 10, "key");
	assert.equal(response.results.length, 1);
	assert.equal(response.results[0].snippet, "Fallback text.");
});

test("searchExa parses Exa errors and redacts the API key", async () => {
	const apiKey = "exa-super-secret";
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				error: `Budget exhausted for ${apiKey}`,
				tag: "NO_MORE_CREDITS",
				requestId: "request-123",
			}),
			{ status: 402 },
		);

	await assert.rejects(
		searchExa("query", 5, apiKey),
		(error: Error) => {
			assert.match(error.message, /Exa returned HTTP 402/);
			assert.match(error.message, /Budget exhausted for \[redacted\]/);
			assert.match(error.message, /tag: NO_MORE_CREDITS/);
			assert.match(error.message, /requestId: request-123/);
			assert.doesNotMatch(error.message, new RegExp(apiKey));
			return true;
		},
	);
});

test("searchKagi keeps existing normalization behavior", async () => {
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				data: {
					search: [
						{
							title: "<strong>Kagi result</strong>",
							url: "https://www.kagi.example/page",
							snippet: "Useful &amp; current",
							time: "2026-07-09",
						},
					],
				},
			}),
			{ status: 200 },
		);

	const response = await searchKagi("query", 5, "kagi-token");
	assert.deepEqual(response.results, [
		{
			title: "Kagi result",
			url: "https://www.kagi.example/page",
			snippet: "Useful & current",
			publishedDate: "2026-07-09",
			source: "kagi.example",
		},
	]);
});

test("searchKagi preserves generic array error and trace parsing", async () => {
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({ errors: [{ message: "Quota exceeded" }], meta: { trace: "trace-42" } }),
			{ status: 429 },
		);

	await assert.rejects(searchKagi("query", 5, "token"), /Kagi returned HTTP 429: Quota exceeded \(trace: trace-42\)/);
});
