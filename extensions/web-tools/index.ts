/**
 * Web Tools Extension for Pi
 *
 * Provides web-fetch and web-search tools.
 *
 * Environment variables:
 * - EXA_API_KEY: Optional, for authenticated Exa API access
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
    type FetchFormat,
    type FetchResult,
    fetchHtml,
    fetchJson,
    fetchMarkdown,
    fetchText,
} from "./fetcher.js";
import type { SearchResult } from "./searcher.js";
import { search } from "./searcher.js";

export default function webToolsExtension(pi: ExtensionAPI) {
    pi.registerTool({
        name: "web-fetch",
        label: "Web Fetch",
        description:
            "Fetch and extract content from a URL. Returns content in the specified format (markdown by default). Useful for reading web pages, articles, documentation, etc.",
        parameters: Type.Object({
            url: Type.String({ description: "URL to fetch" }),
            format: Type.Optional(
                StringEnum(["markdown", "text", "html", "json"] as const, {
                    description: "Output format: markdown (default), text, html, or json",
                    default: "markdown",
                }),
            ),
            headers: Type.Optional(
                Type.Record(Type.String(), Type.String(), {
                    description: "Optional custom headers for the request",
                }),
            ),
        }),

        renderCall(args, theme) {
            const text =
                theme.fg("toolTitle", theme.bold("web-fetch ")) +
                theme.fg("muted", args.url) +
                theme.fg("dim", ` ${args.format ?? "markdown"}`);
            return new Text(text, 0, 0);
        },

        renderResult(result, { expanded }, theme) {
            const details = result.details as
                | { url: string; format: string; contentLength: number; error?: string }
                | undefined;

            if (!details) {
                const text = result.content[0];
                return new Text(text?.type === "text" ? text.text : "", 0, 0);
            }

            if (details.error) {
                return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
            }

            const content = result.content[0]?.type === "text" ? result.content[0].text : "";

            if (expanded) {
                const header =
                    theme.fg("success", `${details.contentLength} chars`) +
                    theme.fg("dim", ` (${details.format})`);
                return new Text(`${header}\n${content}`, 0, 0);
            }

            const PREVIEW_LINES = 5;
            const lines = content.split("\n").filter((l) => l.trim());
            const preview = lines.slice(0, PREVIEW_LINES);
            let text = preview.map((l) => theme.fg("dim", truncateToWidth(l, 120))).join("\n");
            if (lines.length > PREVIEW_LINES) {
                text += `\n${theme.fg("dim", `... ${lines.length - PREVIEW_LINES} more lines `)}${theme.fg("dim", `${keyHint("expandTools", "to expand")}`)}`;
            }
            return new Text(text, 0, 0);
        },

        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const {
                url,
                format = "markdown",
                headers,
            } = params as {
                url: string;
                format?: FetchFormat;
                headers?: Record<string, string>;
            };

            try {
                new URL(url);
            } catch {
                return {
                    content: [{ type: "text", text: `Invalid URL: ${url}` }],
                    details: { url, format, contentLength: 0, error: `Invalid URL: ${url}` },
                    isError: true,
                };
            }

            const fetchParams = { url, headers };

            let result: FetchResult;
            switch (format) {
                case "html":
                    result = await fetchHtml(fetchParams);
                    break;
                case "json":
                    result = await fetchJson(fetchParams);
                    break;
                case "text":
                    result = await fetchText(fetchParams);
                    break;
                default:
                    result = await fetchMarkdown(fetchParams);
                    break;
            }

            if (result.isError) {
                return {
                    content: [{ type: "text", text: result.content }],
                    details: { url, format, contentLength: 0, error: result.content },
                    isError: true,
                };
            }

            return {
                content: [{ type: "text", text: result.content }],
                details: { url, format, contentLength: result.content.length },
                isError: false,
            };
        },
    });

    pi.registerTool({
        name: "web-search",
        label: "Web Search",
        description:
            "Search the web using Exa AI. Returns relevant search results with titles, URLs, and content snippets.",
        parameters: Type.Object({
            query: Type.String({ description: "Search query" }),
            numResults: Type.Optional(
                Type.Number({
                    description: "Number of results to return (default: 8)",
                    default: 8,
                    minimum: 1,
                    maximum: 20,
                }),
            ),
        }),

        renderCall(args, theme) {
            const text =
                theme.fg("toolTitle", theme.bold("web-search ")) +
                theme.fg("muted", `${args.query}`) +
                theme.fg("dim", `:${args.numResults ?? 8}`);
            return new Text(text, 0, 0);
        },

        renderResult(result, { expanded }, theme) {
            const details = result.details as
                | { query: string; results: SearchResult[]; error?: string }
                | undefined;

            if (!details) {
                const text = result.content[0];
                return new Text(text?.type === "text" ? text.text : "", 0, 0);
            }

            if (details.error) {
                return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
            }

            if (expanded) {
                const lines = details.results.map((r, i) => {
                    let entry = `${theme.fg("accent", `${i + 1}.`)} ${theme.fg("muted", r.title)}\n`;
                    entry += `   ${theme.fg("dim", r.url)}`;
                    if (r.publishedDate) {
                        entry += `\n   ${theme.fg("dim", r.publishedDate)}`;
                    }
                    if (r.text) {
                        entry += `\n   ${theme.fg("dim", r.text)}`;
                    }
                    return entry;
                });
                return new Text(lines.join("\n"), 0, 0);
            }

            const lines = details.results.map(
                (r, i) =>
                    `${theme.fg("accent", `${i + 1}.`)} ${theme.fg("muted", r.title)} ${theme.fg("dim", r.url)}`,
            );
            let text = lines.join("\n");
            text += `\n${theme.fg("dim", `${keyHint("expandTools", "to show details")}`)}`;
            return new Text(text, 0, 0);
        },

        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const { query, numResults = 8 } = params as {
                query: string;
                numResults?: number;
            };

            const apiKey = process.env.EXA_API_KEY;
            const response = await search(query, numResults, apiKey);

            if (response.isError) {
                return {
                    content: [{ type: "text", text: response.error || "Search failed" }],
                    details: { query, results: [], error: response.error },
                    isError: true,
                };
            }

            const formattedResults = response.results
                .map((r, i) => {
                    let entry = `## ${i + 1}. ${r.title}\n`;
                    entry += `**URL:** ${r.url}\n`;
                    if (r.publishedDate) {
                        entry += `**Published:** ${r.publishedDate}\n`;
                    }
                    if (r.text) {
                        entry += `\n${r.text}\n`;
                    }
                    return entry;
                })
                .join("\n---\n\n");

            const output = `# Search Results for: "${query}"\n\nFound ${response.results.length} results.\n\n${formattedResults}`;

            return {
                content: [{ type: "text", text: output }],
                details: { query, results: response.results },
                isError: false,
            };
        },
    });
}
