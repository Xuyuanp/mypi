/**
 * Web Search Extension
 *
 * Registers a `websearch` tool that searches the web via Exa MCP server
 * using mcporter CLI. Results are shown collapsed by default (titles + URLs);
 * use Ctrl+O to expand and view full content.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface SearchResult {
	title: string;
	url: string;
	text: string;
}

interface WebSearchDetails {
	query: string;
	results: SearchResult[];
	error?: string;
}

/** Parse raw text content from Exa into structured results. */
function parseResults(raw: string): SearchResult[] {
	const results: SearchResult[] = [];
	const blocks = raw.split(/\n(?=Title: )/);
	for (const block of blocks) {
		const titleMatch = block.match(/^Title: (.+)/m);
		const urlMatch = block.match(/^URL: (.+)/m);
		const textMatch = block.match(/^Text: ([\s\S]+)/m);
		if (titleMatch && urlMatch) {
			results.push({
				title: titleMatch[1].trim(),
				url: urlMatch[1].trim(),
				text: textMatch ? textMatch[1].trim() : "",
			});
		}
	}
	return results;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "websearch",
		label: "Web Search",
		description: "Search the web for any topic and get clean, ready-to-use content from top results.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
		}),

		async execute(_toolCallId, params, signal) {
			const result = await pi.exec(
				"mcporter",
				["call", "exa.web_search_exa", `query=${params.query}`, "numResults:3", "--output", "json"],
				{ signal, timeout: 30000 },
			);

			if (result.code !== 0) {
				const error = result.stderr || `mcporter exited with code ${result.code}`;
				return {
					content: [{ type: "text", text: `Search failed: ${error}` }],
					details: { query: params.query, results: [], error } as WebSearchDetails,
					isError: true,
				};
			}

			let fullText: string;
			try {
				const parsed = JSON.parse(result.stdout);
				fullText =
					parsed.content
						?.filter((c: { type: string }) => c.type === "text")
						.map((c: { text: string }) => c.text)
						.join("\n\n") || "";
			} catch {
				fullText = result.stdout || "";
			}

			const results = parseResults(fullText);

			return {
				content: [{ type: "text", text: fullText || "No results found." }],
				details: { query: params.query, results } as WebSearchDetails,
			};
		},

		renderCall(args, theme) {
			const text = theme.fg("toolTitle", theme.bold("websearch ")) + theme.fg("accent", `"${args.query}"`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as WebSearchDetails | undefined;

			if (isPartial) {
				return new Text(theme.fg("warning", "Searching…"), 0, 0);
			}

			if (details?.error) {
				return new Text(theme.fg("error", `Search failed: ${details.error}`), 0, 0);
			}

			if (!details?.results.length) {
				return new Text(theme.fg("dim", "No results found."), 0, 0);
			}

			const lines: string[] = [];

			if (expanded) {
				for (const r of details.results) {
					lines.push(theme.fg("accent", theme.bold(r.title)));
					lines.push(theme.fg("dim", r.url));
					if (r.text) {
						lines.push("");
						lines.push(r.text);
					}
					lines.push("");
				}
			} else {
				for (const r of details.results) {
					lines.push(`${theme.fg("accent", r.title)}  ${theme.fg("dim", r.url)}`);
				}
				lines.push("");
				lines.push(theme.fg("muted", `${details.results.length} results (${keyHint("expandTools", "to expand")})`));
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
