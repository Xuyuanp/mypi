/**
 * Tests for the opencode-session-pin extension.
 *
 * Unit tests cover the pure suffix-rewriting helper. A handler test
 * verifies the extension registers a before_provider_headers hook that
 * mutates the outgoing header in place. A headless boot test confirms
 * the extension loads inside a real SDK session without throwing.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FauxProviderRegistration } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxText,
    registerFauxProvider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import opencodeSessionPin, {
    PIN_SUFFIX,
    pinSessionSuffix,
} from "../extensions/opencode-session-pin.js";
import { createFauxModelRuntime } from "./test-utils.js";

// ── Unit tests: pinSessionSuffix ───────────────────────────────────────

describe("pinSessionSuffix", () => {
    const UUID = "01a017e0-5481-7e2d-8c95-34afa7ca34b3";

    it("replaces the trailing 4 chars with the pin suffix", () => {
        const result = pinSessionSuffix(UUID);
        expect(result).toBe(`${UUID.slice(0, -4)}${PIN_SUFFIX}`);
        expect(result.endsWith(PIN_SUFFIX)).toBe(true);
    });

    it("keeps the prefix untouched", () => {
        const result = pinSessionSuffix(UUID);
        expect(result.slice(0, -PIN_SUFFIX.length)).toBe(
            UUID.slice(0, -PIN_SUFFIX.length),
        );
    });

    it("converts an id of exactly 4 chars", () => {
        expect(pinSessionSuffix("abcd")).toBe(PIN_SUFFIX);
    });

    it("converts an id of exactly 5 chars", () => {
        expect(pinSessionSuffix("abcde")).toBe(`a${PIN_SUFFIX}`);
    });

    it("leaves ids shorter than the suffix untouched", () => {
        expect(pinSessionSuffix("ab")).toBe("ab");
        expect(pinSessionSuffix("")).toBe("");
    });

    it("leaves an already pinned id untouched", () => {
        expect(pinSessionSuffix(`abc-${PIN_SUFFIX}`)).toBe(`abc-${PIN_SUFFIX}`);
    });
});

// ── Handler wiring tests ───────────────────────────────────────────────

type HeaderEventHandler = (event: {
    type: string;
    headers: Record<string, string | null>;
}) => void;

function captureHeaderHandlers(
    extension: (pi: ExtensionAPI) => void,
): HeaderEventHandler[] {
    const handlers: HeaderEventHandler[] = [];
    const fakePi = {
        on: (name: string, handler: HeaderEventHandler) => {
            if (name === "before_provider_headers") handlers.push(handler);
        },
    };
    extension(fakePi as unknown as ExtensionAPI);
    return handlers;
}

describe("opencode-session-pin handler", () => {
    it("registers a before_provider_headers hook", () => {
        const handlers = captureHeaderHandlers(opencodeSessionPin);
        expect(handlers).toHaveLength(1);
    });

    it("mutates the x-opencode-session header in place", () => {
        const [handler] = captureHeaderHandlers(opencodeSessionPin);
        const event = {
            type: "before_provider_headers",
            headers: {
                "x-opencode-session": "01a017e0-5481-7e2d-8c95-34afa7ca34b3",
                "x-opencode-client": "pi",
            },
        };
        handler(event);
        expect(event.headers["x-opencode-session"]).toBe(
            "01a017e0-5481-7e2d-8c95-34afa7ca34b3".slice(0, -4) + PIN_SUFFIX,
        );
    });

    it("leaves other headers untouched", () => {
        const [handler] = captureHeaderHandlers(opencodeSessionPin);
        const event = {
            type: "before_provider_headers",
            headers: { "x-opencode-client": "pi" },
        };
        handler(event);
        expect(event.headers).toEqual({ "x-opencode-client": "pi" });
    });

    it("no-ops when the session header is null", () => {
        const [handler] = captureHeaderHandlers(opencodeSessionPin);
        const event = {
            type: "before_provider_headers",
            headers: { "x-opencode-session": null },
        };
        handler(event);
        expect(event.headers["x-opencode-session"]).toBeNull();
    });
});

// ── Headless boot test ─────────────────────────────────────────────────

describe("opencode-session-pin extension (headless)", () => {
    let tmpDir: string;
    let faux: FauxProviderRegistration;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "opencode-session-pin-test-"));
        faux = registerFauxProvider();
    });

    afterEach(async () => {
        faux.unregister();
        await rm(tmpDir, { recursive: true, force: true });
    });

    it("loads and runs a turn without error when headless", async () => {
        faux.setResponses([fauxAssistantMessage(fauxText("done"))]);

        const model = faux.getModel()!;
        const modelRuntime = await createFauxModelRuntime(faux);
        const settingsManager = SettingsManager.inMemory({
            compaction: { enabled: false },
            retry: { enabled: false },
        });
        const resourceLoader = new DefaultResourceLoader({
            cwd: tmpDir,
            agentDir: join(tmpDir, ".pi-test-agent"),
            settingsManager,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [opencodeSessionPin],
            systemPromptOverride: () => "You are a test assistant.",
        });
        await resourceLoader.reload();

        const { session } = await createAgentSession({
            cwd: tmpDir,
            agentDir: join(tmpDir, ".pi-test-agent"),
            model,
            thinkingLevel: "off",
            resourceLoader,
            sessionManager: SessionManager.inMemory(),
            settingsManager,
            modelRuntime,
        });

        await expect(session.prompt("go")).resolves.toBeUndefined();
        session.dispose();
    });
});
