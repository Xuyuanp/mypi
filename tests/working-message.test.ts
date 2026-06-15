/**
 * Tests for the working-message extension.
 *
 * Unit tests cover the pure animation helpers (frame baking, ANSI parsing,
 * phrase formatting, no-repeat word picking). An integration test boots a
 * headless SDK session and confirms the extension runs through multiple turns
 * without throwing. UI calls (setWorkingMessage / setWorkingIndicator) cannot
 * be asserted in integration because SDK sessions are headless (hasUI=false),
 * so the handlers correctly no-op there -- see implementation-notes.md.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FauxProviderRegistration } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    registerFauxProvider,
} from "@earendil-works/pi-ai";
import {
    AuthStorage,
    createAgentSession,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import workingMessage, {
    buildSweepFrames,
    FRAME_COUNT,
    formatPhrase,
    parseFgAnsiToRgb,
    pickWorkingWords,
    SPINNER_GLYPHS,
} from "../extensions/working-message.js";

// ── Helpers ────────────────────────────────────────────────────────────

const PEAK = { r: 29, g: 158, b: 117 };
const BASE = { r: 107, g: 114, b: 128 };
const ACCENT = { r: 138, g: 190, b: 183 };

// Strip every SGR sequence to recover the underlying plain text.
function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// Index of the character carrying the brightest (closest to peak) color.
function brightestIndex(frame: string): number {
    const re = /\x1b\[38;2;(\d+);(\d+);(\d+)m./g;
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    let i = 0;
    let m: RegExpExecArray | null = re.exec(frame);
    while (m !== null) {
        const r = Number(m[1]);
        const g = Number(m[2]);
        const b = Number(m[3]);
        const dist = (r - PEAK.r) ** 2 + (g - PEAK.g) ** 2 + (b - PEAK.b) ** 2;
        if (dist < bestDist) {
            bestDist = dist;
            best = i;
        }
        i++;
        m = re.exec(frame);
    }
    return best;
}

// ── Unit tests: pure helpers ─────────────────────────────────────────────

describe("working-message helpers", () => {
    describe("formatPhrase", () => {
        it("joins words without a trailing ellipsis", () => {
            const phrase = formatPhrase({
                verb: "Frobnicating",
                adjective: "spicy",
                noun: "bytes",
            });
            expect(phrase).toBe("Frobnicating the spicy bytes");
        });
    });

    describe("parseFgAnsiToRgb", () => {
        it("parses a truecolor foreground sequence", () => {
            expect(parseFgAnsiToRgb("\x1b[38;2;29;158;117m")).toEqual({
                r: 29,
                g: 158,
                b: 117,
            });
        });

        it("returns undefined for a 256-color sequence", () => {
            expect(parseFgAnsiToRgb("\x1b[38;5;42m")).toBeUndefined();
        });

        it("returns undefined for the default-foreground sequence", () => {
            expect(parseFgAnsiToRgb("\x1b[39m")).toBeUndefined();
        });

        it("rejects out-of-range channel values", () => {
            expect(parseFgAnsiToRgb("\x1b[38;2;300;0;0m")).toBeUndefined();
        });
    });

    describe("buildSweepFrames", () => {
        const text = "Reticulating the off-by-one yaks";
        const frames = buildSweepFrames({ text, peak: PEAK, base: BASE });

        it("produces exactly FRAME_COUNT frames", () => {
            expect(frames).toHaveLength(FRAME_COUNT);
        });

        it("preserves the underlying text verbatim in every frame", () => {
            for (const frame of frames) {
                expect(stripAnsi(frame)).toBe(text);
            }
        });

        it("terminates every frame with a full reset", () => {
            for (const frame of frames) {
                expect(frame.endsWith("\x1b[0m")).toBe(true);
            }
        });

        it("colors every character with a truecolor foreground", () => {
            const count = (frames[0].match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? []).length;
            expect(count).toBe(text.length);
        });

        it("advances the bright peak across the string over the loop", () => {
            // Sample frames where the peak is on-string (the band fully exits
            // past both ends by design, so the first/last frames are all-base).
            const sampled = [6, 12, 18, 24, 30].map((f) =>
                brightestIndex(frames[f]),
            );
            for (let i = 1; i < sampled.length; i++) {
                expect(sampled[i]).toBeGreaterThan(sampled[i - 1]);
            }
            // And the peak should traverse most of the string.
            expect(sampled[0]).toBeLessThan(text.length / 3);
            expect(sampled[sampled.length - 1]).toBeGreaterThan(
                (text.length * 2) / 3,
            );
        });

        it("returns a single empty frame for empty text", () => {
            expect(buildSweepFrames({ text: "", peak: PEAK, base: BASE })).toEqual([
                "",
            ]);
        });

        it("fully exits at both ends for the longest phrase (seamless loop)", () => {
            // A frame is all-base when every character renders the base color.
            const isAllBase = (frame: string): boolean => {
                const re = /\x1b\[38;2;(\d+);(\d+);(\d+)m/g;
                let m: RegExpExecArray | null = re.exec(frame);
                while (m !== null) {
                    if (
                        Number(m[1]) !== BASE.r ||
                        Number(m[2]) !== BASE.g ||
                        Number(m[3]) !== BASE.b
                    ) {
                        return false;
                    }
                    m = re.exec(frame);
                }
                return true;
            };
            const longest = "x".repeat(60);
            const longFrames = buildSweepFrames({
                text: longest,
                peak: PEAK,
                base: BASE,
            });
            expect(isAllBase(longFrames[0])).toBe(true);
            expect(isAllBase(longFrames[FRAME_COUNT - 1])).toBe(true);
        });
    });

    describe("buildSweepFrames with spinner prefix", () => {
        const text = "Reticulating the off-by-one yaks";
        const spinner = { glyphs: SPINNER_GLYPHS, color: ACCENT };
        const frames = buildSweepFrames({
            text,
            peak: PEAK,
            base: BASE,
            spinner,
        });

        it("prefixes the plain text with the cycling spinner glyph + space", () => {
            for (let f = 0; f < FRAME_COUNT; f++) {
                const glyph = SPINNER_GLYPHS[f % SPINNER_GLYPHS.length];
                expect(stripAnsi(frames[f])).toBe(`${glyph} ${text}`);
            }
        });

        it("cycles the spinner seamlessly (FRAME_COUNT divisible by glyphs)", () => {
            expect(FRAME_COUNT % SPINNER_GLYPHS.length).toBe(0);
        });

        it("colors the spinner glyph with the accent color", () => {
            const accentSeq = `\x1b[38;2;${ACCENT.r};${ACCENT.g};${ACCENT.b}m`;
            const glyph = SPINNER_GLYPHS[0];
            expect(frames[0].startsWith(`${accentSeq}${glyph}\x1b[0m `)).toBe(true);
        });

        it("still terminates every frame with a full reset", () => {
            for (const frame of frames) {
                expect(frame.endsWith("\x1b[0m")).toBe(true);
            }
        });
    });

    describe("pickWorkingWords", () => {
        it("never repeats the previous word in any category", () => {
            let prev = pickWorkingWords();
            for (let i = 0; i < 200; i++) {
                const next = pickWorkingWords(prev);
                expect(next.verb).not.toBe(prev.verb);
                expect(next.adjective).not.toBe(prev.adjective);
                expect(next.noun).not.toBe(prev.noun);
                prev = next;
            }
        });
    });
});

// ── Lifecycle: handler contract with a fake pi / ctx ─────────────────────

type Handler = (event: unknown, ctx: unknown) => unknown;

function makeCtx(hasUI: boolean) {
    const calls: { method: string; arg: unknown }[] = [];
    const ctx = {
        hasUI,
        ui: {
            theme: {
                getFgAnsi: (color: string) => {
                    const map: Record<string, string> = {
                        text: "\x1b[38;2;212;212;212m",
                        dim: "\x1b[38;2;107;114;128m",
                        accent: "\x1b[38;2;138;190;183m",
                    };
                    return map[color] ?? "\x1b[39m";
                },
            },
            setWorkingMessage: (arg?: unknown) =>
                calls.push({ method: "setWorkingMessage", arg }),
            setWorkingIndicator: (arg?: unknown) =>
                calls.push({ method: "setWorkingIndicator", arg }),
        },
    };
    return { ctx, calls };
}

function loadHandlers() {
    const handlers = new Map<string, Handler>();
    const pi = {
        on: (event: string, handler: Handler) => handlers.set(event, handler),
    };
    workingMessage(pi as any);
    return handlers;
}

describe("working-message lifecycle", () => {
    it("sets '...' message and an animated indicator on turn_start", async () => {
        const handlers = loadHandlers();
        const { ctx, calls } = makeCtx(true);
        await handlers.get("turn_start")!({}, ctx);

        const msg = calls.find((c) => c.method === "setWorkingMessage");
        const ind = calls.find((c) => c.method === "setWorkingIndicator");
        expect(msg?.arg).toBe("...");
        expect(ind).toBeDefined();
        const opts = ind!.arg as { frames: string[]; intervalMs: number };
        expect(opts.frames).toHaveLength(FRAME_COUNT);
        expect(opts.intervalMs).toBeGreaterThan(0);
        // First frame must carry the accent-colored spinner prefix.
        expect(opts.frames[0].startsWith("\x1b[38;2;138;190;183m")).toBe(true);
    });

    it("restores defaults on turn_end and agent_end", async () => {
        const handlers = loadHandlers();
        for (const event of ["turn_end", "agent_end"]) {
            const { ctx, calls } = makeCtx(true);
            await handlers.get(event)!({}, ctx);
            expect(calls).toEqual([
                { method: "setWorkingMessage", arg: undefined },
                { method: "setWorkingIndicator", arg: undefined },
            ]);
        }
    });

    it("no-ops on every lifecycle event when hasUI is false", async () => {
        const handlers = loadHandlers();
        for (const event of ["turn_start", "turn_end", "agent_end"]) {
            const { ctx, calls } = makeCtx(false);
            await handlers.get(event)!({}, ctx);
            expect(calls).toHaveLength(0);
        }
    });
});

// ── Integration: headless session runs without throwing ──────────────────

describe("working-message extension (headless)", () => {
    let tmpDir: string;
    let faux: FauxProviderRegistration;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "working-message-test-"));
        faux = registerFauxProvider();
    });

    afterEach(async () => {
        faux.unregister();
        await rm(tmpDir, { recursive: true, force: true });
    });

    it("runs through multiple turns without error when headless", async () => {
        faux.setResponses([
            fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }), {
                stopReason: "toolUse",
            }),
            fauxAssistantMessage(fauxText("done")),
        ]);

        const model = faux.getModel()!;
        const authStorage = AuthStorage.inMemory();
        authStorage.setRuntimeApiKey(model.provider, "fake-key");
        const modelRegistry = ModelRegistry.inMemory(authStorage);
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
            extensionFactories: [workingMessage],
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
            authStorage,
            modelRegistry,
        });

        await expect(session.prompt("go")).resolves.toBeUndefined();
        session.dispose();
    });
});
