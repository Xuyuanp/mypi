// jsdom is lazy-loaded in fetchText() to avoid ~350ms startup penalty
let _JSDOM: typeof import("jsdom").JSDOM | undefined;

export type FetchFormat = "markdown" | "text" | "html" | "json";

export type FetchParams = {
    url: string;
    headers?: Record<string, string>;
};

export type FetchResult = {
    content: string;
    isError: boolean;
};

const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

async function fetchUrl(params: FetchParams): Promise<Response> {
    const { url, headers } = params;

    const response = await fetch(url, {
        headers: {
            "User-Agent": DEFAULT_USER_AGENT,
            ...headers,
        },
    });

    if (!response.ok) {
        throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }

    return response;
}

function errorResult(error: unknown): FetchResult {
    return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
    };
}

function stripNoise(document: Document, selectors: string[]) {
    for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
            el.remove();
        }
    }
}

export async function fetchHtml(params: FetchParams): Promise<FetchResult> {
    try {
        const response = await fetchUrl(params);
        const html = await response.text();
        return { content: html, isError: false };
    } catch (error) {
        return errorResult(error);
    }
}

export async function fetchJson(params: FetchParams): Promise<FetchResult> {
    try {
        const response = await fetchUrl(params);
        const json = await response.json();
        return { content: JSON.stringify(json, null, 2), isError: false };
    } catch (error) {
        return errorResult(error);
    }
}

export async function fetchText(params: FetchParams): Promise<FetchResult> {
    try {
        const response = await fetchUrl(params);
        const html = await response.text();

        if (!_JSDOM) {
            _JSDOM = (await import("jsdom")).JSDOM;
        }
        const dom = new _JSDOM(html);
        const document = dom.window.document;
        stripNoise(document, ["script", "style"]);

        const text = document.body?.textContent || "";
        const normalizedText = text.replace(/\s+/g, " ").trim();

        return { content: normalizedText, isError: false };
    } catch (error) {
        return errorResult(error);
    }
}

const JINA_READER_PREFIX = "https://r.jina.ai/";

export async function fetchMarkdown(params: FetchParams): Promise<FetchResult> {
    try {
        const jinaUrl = `${JINA_READER_PREFIX}${params.url}`;
        const response = await fetchUrl({ ...params, url: jinaUrl });
        const markdown = await response.text();
        return { content: markdown, isError: false };
    } catch (error) {
        return errorResult(error);
    }
}
