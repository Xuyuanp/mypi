/**
 * Unit tests for the herdr "blocked" signal of the questionnaire extension.
 *
 * The TUI is not rendered here. The test drives the wrapper directly and
 * records what it emits on the shared extension event bus.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { withHerdrBlocked } from "../extensions/questionnaire.js";

type Emitted = { channel: string; data: unknown };

function fakePi(sink: Emitted[]): ExtensionAPI {
    return {
        events: {
            emit: (channel: string, data: unknown) => {
                sink.push({ channel, data });
            },
        },
    } as unknown as ExtensionAPI;
}

describe("withHerdrBlocked", () => {
    it("brackets the blocking call with an active and a released signal", async () => {
        const sink: Emitted[] = [];
        const pi = fakePi(sink);

        const result = await withHerdrBlocked(pi, "Scope, Priority", () => {
            sink.push({ channel: "run", data: undefined });
            return Promise.resolve("answer");
        });

        expect(result).toBe("answer");
        expect(sink).toEqual([
            {
                channel: "herdr:blocked",
                data: { active: true, label: "Scope, Priority" },
            },
            { channel: "run", data: undefined },
            { channel: "herdr:blocked", data: { active: false } },
        ]);
    });

    it("releases the signal when the blocking call throws", async () => {
        const sink: Emitted[] = [];
        const pi = fakePi(sink);

        await expect(
            withHerdrBlocked(pi, "Scope", () => Promise.reject(new Error("boom"))),
        ).rejects.toThrow("boom");

        expect(sink).toEqual([
            { channel: "herdr:blocked", data: { active: true, label: "Scope" } },
            { channel: "herdr:blocked", data: { active: false } },
        ]);
    });
});
