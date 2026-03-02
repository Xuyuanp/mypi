import { JSDOM } from "jsdom";
import TurndownService from "turndown";

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
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

        const dom = new JSDOM(html);
        const document = dom.window.document;
        stripNoise(document, ["script", "style"]);

        const text = document.body?.textContent || "";
        const normalizedText = text.replace(/\s+/g, " ").trim();

        return { content: normalizedText, isError: false };
    } catch (error) {
        return errorResult(error);
    }
}

const MARKDOWN_NOISE_SELECTORS = [
    "script",
    "style",
    "nav",
    "footer",
    "header",
    "aside",
];

export async function fetchMarkdown(params: FetchParams): Promise<FetchResult> {
    try {
        const response = await fetchUrl(params);
        const html = await response.text();

        const dom = new JSDOM(html);
        const document = dom.window.document;
        stripNoise(document, MARKDOWN_NOISE_SELECTORS);

        const turndownService = new TurndownService({
            headingStyle: "atx",
            codeBlockStyle: "fenced",
        });

        const main = document.querySelector("main, article, .content, #content");
        const contentElement = main || document.body;
        const markdown = turndownService.turndown(contentElement?.innerHTML || "");

        return { content: markdown, isError: false };
    } catch (error) {
        return errorResult(error);
    }
}
