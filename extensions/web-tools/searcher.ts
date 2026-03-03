const DEFAULT_NUM_RESULTS = 8;
const REQUEST_TIMEOUT_MS = 25000;
const DEFAULT_SEARXNG_BASE = "http://localhost:8888";

type SearxngResult = {
    url: string;
    title: string;
    content: string;
    publishedDate: string | null;
    engines: string[];
    category: string;
    score: number;
};

type SearxngResponse = {
    query: string;
    number_of_results: number;
    results: SearxngResult[];
};

export type SearchResult = {
    title: string;
    url: string;
    text: string;
    publishedDate?: string;
    engines?: string[];
    category?: string;
};

export type SearchResponse = {
    query: string;
    results: SearchResult[];
    isError: boolean;
    error?: string;
};

function mapResults(raw: SearxngResult[], limit: number): SearchResult[] {
    return raw.slice(0, limit).map((r) => ({
        title: r.title || "No title",
        url: r.url || "",
        text: r.content || "",
        publishedDate: r.publishedDate ?? undefined,
        engines: r.engines,
        category: r.category,
    }));
}

export async function search(
    query: string,
    numResults: number = DEFAULT_NUM_RESULTS,
    baseUrl?: string,
): Promise<SearchResponse> {
    if (!query.trim()) {
        return {
            query,
            results: [],
            isError: true,
            error: "Search query cannot be empty",
        };
    }

    const base = baseUrl || process.env.SEARXNG_API_BASE || DEFAULT_SEARXNG_BASE;
    const url = new URL("/search", base);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(url.toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
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

        const data: SearxngResponse = await response.json();
        const results = mapResults(data.results ?? [], numResults);

        return {
            query,
            results,
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
