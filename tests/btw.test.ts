/**
 * Unit tests for the /btw cache-marker relocation hook.
 *
 * `moveCacheMarkerToSharedPrefix` is the `onPayload` callback used to move
 * the single Anthropic `cache_control` marker off the newest (side-question)
 * message and onto the second-to-last message. These tests focus on the
 * field-preservation guarantee: the hook must mutate in place and never drop
 * any unrelated fields from the original payload or its message blocks.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { moveCacheMarkerToSharedPrefix } from "../extensions/btw.js";

const ANTHROPIC = { api: "anthropic-messages" } as unknown as Model<Api>;
const OPENAI = { api: "openai-completions" } as unknown as Model<Api>;

const MARKER = { type: "ephemeral", ttl: "1h" };

/**
 * A rich payload mirroring what the Anthropic provider builds: top-level
 * fields plus messages whose blocks carry provider-specific fields
 * (tool_use.id/input, thinking.signature, tool_result.tool_use_id, image
 * source, and arbitrary extra keys) that MUST survive the transform.
 */
function makeRichPayload() {
    return {
        model: "claude-sonnet-4",
        max_tokens: 8192,
        stream: true,
        system: [{ type: "text", text: "system", cache_control: MARKER }],
        tools: [{ name: "read", description: "d", input_schema: {} }],
        thinking: { type: "adaptive", display: "summarized" },
        metadata: { user_id: "u1" },
        messages: [
            { role: "user", content: "first turn" },
            {
                role: "assistant",
                content: [
                    {
                        type: "thinking",
                        thinking: "hmm",
                        signature: "sig-abc",
                    },
                    { type: "text", text: "let me read" },
                    {
                        type: "tool_use",
                        id: "toolu_1",
                        name: "read",
                        input: { path: "a.ts" },
                    },
                ],
            },
            // N-2: last prefix point shared with the parent (target)
            {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "toolu_1",
                        content: "file body",
                        is_error: false,
                    },
                    { type: "text", text: "last parent user block" },
                ],
            },
            // N-1: newest side-question message carrying the marker
            {
                role: "user",
                content: [
                    { type: "image", source: { type: "base64", data: "xx" } },
                    {
                        type: "text",
                        text: "side question",
                        cache_control: MARKER,
                    },
                ],
            },
        ],
    };
}

describe("moveCacheMarkerToSharedPrefix", () => {
    it("moves the marker N-1 -> N-2 without losing any fields", () => {
        const input = makeRichPayload();
        const result = moveCacheMarkerToSharedPrefix(input, ANTHROPIC);

        // Mutates and returns the same object reference.
        expect(result).toBe(input);

        // Build the expected end state from a fresh copy: marker removed from
        // the newest message's text block, added to N-2's last block.
        const expected = makeRichPayload();
        const newest = expected.messages[3].content as Array<
            Record<string, unknown>
        >;
        newest[newest.length - 1].cache_control = undefined;
        const target = expected.messages[2].content as Array<
            Record<string, unknown>
        >;
        target[target.length - 1].cache_control = MARKER;

        // toEqual ignores `undefined` props, matching the removed marker, and
        // verifies every other field (top-level + nested block fields) survives.
        expect(input).toEqual(expected);
    });

    it("preserves provider-specific block fields on both messages", () => {
        const input = makeRichPayload();
        moveCacheMarkerToSharedPrefix(input, ANTHROPIC);

        const target = input.messages[2].content as Array<
            Record<string, unknown>
        >;
        expect(target[0]).toMatchObject({
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "file body",
            is_error: false,
        });
        expect(target[1]).toEqual({
            type: "text",
            text: "last parent user block",
            cache_control: MARKER,
        });

        const newest = input.messages[3].content as Array<
            Record<string, unknown>
        >;
        expect(newest[0]).toEqual({
            type: "image",
            source: { type: "base64", data: "xx" },
        });
        expect(newest[1].cache_control).toBeUndefined();
        expect(newest[1]).toMatchObject({ type: "text", text: "side question" });
    });

    it("normalizes string target content into a text block, losing nothing", () => {
        const input = {
            messages: [
                { role: "assistant", content: "answer" },
                { role: "user", content: "last parent user turn" },
                {
                    role: "user",
                    content: [{ type: "text", text: "q", cache_control: MARKER }],
                },
            ],
        };
        const result = moveCacheMarkerToSharedPrefix(input, ANTHROPIC) as typeof input;
        expect(result).toBe(input);
        expect(input.messages[1].content).toEqual([
            { type: "text", text: "last parent user turn", cache_control: MARKER },
        ]);
        const newest = input.messages[2].content as Array<
            Record<string, unknown>
        >;
        expect(newest[0].cache_control).toBeUndefined();
    });

    it("leaves payload untouched for non-Anthropic models", () => {
        const input = makeRichPayload();
        const before = structuredClone(input);
        const result = moveCacheMarkerToSharedPrefix(input, OPENAI);
        expect(result).toBeUndefined();
        expect(input).toEqual(before);
    });

    it("bails when there are fewer than two messages", () => {
        const input = {
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "q", cache_control: MARKER }],
                },
            ],
        };
        const before = structuredClone(input);
        expect(moveCacheMarkerToSharedPrefix(input, ANTHROPIC)).toBeUndefined();
        expect(input).toEqual(before);
    });

    it("bails when the N-2 message ends in a non-cacheable block", () => {
        const input = {
            messages: [
                { role: "user", content: "first" },
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            id: "toolu_9",
                            name: "read",
                            input: {},
                        },
                    ],
                },
                {
                    role: "user",
                    content: [{ type: "text", text: "q", cache_control: MARKER }],
                },
            ],
        };
        const before = structuredClone(input);
        // Returns undefined and leaves the source marker intact, so the request
        // keeps the library's default single marker.
        expect(moveCacheMarkerToSharedPrefix(input, ANTHROPIC)).toBeUndefined();
        expect(input).toEqual(before);
    });

    it("bails when the newest message has no marker", () => {
        const input = {
            messages: [
                { role: "user", content: "first parent turn" },
                { role: "user", content: [{ type: "text", text: "q" }] },
            ],
        };
        const before = structuredClone(input);
        expect(moveCacheMarkerToSharedPrefix(input, ANTHROPIC)).toBeUndefined();
        expect(input).toEqual(before);
    });
});
