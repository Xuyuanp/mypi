/**
 * Web Search Extension
 *
 * Registers a `websearch` tool that searches the web via Exa MCP server
 * using mcporter CLI.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "websearch",
		label: "Web Search",
		description: "Search the web for any topic and get clean, ready-to-use content from top results.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
		}),

		async execute(toolCallId, params, signal) {
			const result = await pi.exec(
				"mcporter",
				["call", "exa.web_search_exa", `query=${params.query}`, "numResults:3", "--output", "json"],
				{ signal, timeout: 30000 },
			);

			if (result.code !== 0) {
				const error = result.stderr || `mcporter exited with code ${result.code}`;
				return {
					content: [{ type: "text", text: `Search failed: ${error}` }],
					isError: true,
				};
			}

			try {
				const parsed = JSON.parse(result.stdout);
				const text = parsed.content
					?.filter((c: { type: string }) => c.type === "text")
					.map((c: { text: string }) => c.text)
					.join("\n\n");

				return {
					content: [{ type: "text", text: text || "No results found." }],
				};
			} catch {
				return {
					content: [{ type: "text", text: result.stdout || "No results found." }],
				};
			}
		},
	});
}
