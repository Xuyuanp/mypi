const EXA_API_HOST = "https://mcp.exa.ai/mcp";
const DEFAULT_NUM_RESULTS = 8;
const REQUEST_TIMEOUT_MS = 25000;

type McpSearchRequest = {
    jsonrpc: string;
    id: number;
    method: string;
    params: {
        name: string;
        arguments: {
            query: string;
            numResults?: number;
            livecrawl?: "fallback" | "preferred";
            type?: "auto" | "fast" | "deep";
        };
    };
};

type McpSearchResponse = {
    jsonrpc: string;
    result: {
        content: Array<{ type: string; text: string }>;
    };
};

export type SearchResult = {
    title: string;
    url: string;
    text: string;
    publishedDate?: string;
};

export type SearchResponse = {
    query: string;
    results: SearchResult[];
    isError: boolean;
    error?: string;
};

function parseTextChunk(raw: string): SearchResult[] {
    const items: SearchResult[] = [];
    const blocks = raw.split(/^(?=Title: )/m);

    for (const block of blocks) {
        if (!block.trim()) continue;

        const lines = block.split("\n");
        let title = "";
        let publishedDate = "";
        let url = "";
        let textStartIndex = -1;

        for (const [idx, line] of lines.entries()) {
            if (line.startsWith("Title:") && !title) {
                title = line.replace(/^Title:\s*/, "");
            } else if (line.startsWith("Published Date:")) {
                publishedDate = line.replace(/^Published Date:\s*/, "");
            } else if (line.startsWith("Author:")) {
                // Skip author line
            } else if (line.startsWith("URL:") && !url) {
                url = line.replace(/^URL:\s*/, "");
            } else if (line.startsWith("Text:") && textStartIndex === -1) {
                textStartIndex = idx;
            }
        }

        let fullText = "";
        if (textStartIndex !== -1) {
            const textLine = lines[textStartIndex].replace(/^Text:\s*/, "");
            const rest = lines.slice(textStartIndex + 1).join("\n").trim();
            fullText = rest ? `${textLine}\n${rest}` : textLine;
        }

        if (title || url || fullText) {
            items.push({
                title: title || "No title",
                url: url || "",
                text: fullText,
                publishedDate: publishedDate || undefined,
            });
        }
    }

    return items;
}

function parseResponse(responseText: string): SearchResult[] {
    // Try SSE format first
    const lines = responseText.split("\n");
    for (const line of lines) {
        if (line.startsWith("data: ")) {
            try {
                const data: McpSearchResponse = JSON.parse(line.substring(6));
                if (data.result?.content?.[0]?.text) {
                    return parseTextChunk(data.result.content[0].text);
                }
            } catch {
                // Continue to next line
            }
        }
    }

    // Try direct JSON format
    try {
        const data: McpSearchResponse = JSON.parse(responseText);
        if (data.result?.content?.[0]?.text) {
            return parseTextChunk(data.result.content[0].text);
        }
    } catch {
        // Ignore
    }

    return [];
}

export async function search(
    query: string,
    numResults: number = DEFAULT_NUM_RESULTS,
    apiKey?: string,
): Promise<SearchResponse> {
    if (!query.trim()) {
        return {
            query,
            results: [],
            isError: true,
            error: "Search query cannot be empty",
        };
    }

    const searchRequest: McpSearchRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
            name: "web_search_exa",
            arguments: {
                query,
                type: "auto",
                numResults,
                livecrawl: "fallback",
            },
        },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
        };
        if (apiKey) {
            headers.Authorization = `Bearer ${apiKey}`;
        }

        const response = await fetch(EXA_API_HOST, {
            method: "POST",
            headers,
            body: JSON.stringify(searchRequest),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            return {
                query,
                results: [],
                isError: true,
                error: `Search error (${response.status}): ${errorText}`,
            };
        }

        const responseText = await response.text();
        const results = parseResponse(responseText);

        return {
            query,
            results: results.slice(0, numResults),
            isError: false,
        };
    } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof Error && error.name === "AbortError") {
            return {
                query,
                results: [],
                isError: true,
                error: "Search request timed out",
            };
        }

        return {
            query,
            results: [],
            isError: true,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
