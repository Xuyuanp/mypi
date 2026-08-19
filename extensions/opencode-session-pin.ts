/**
 * Pins OpenCode Go upstream routing to slot 0.
 *
 * OpenCode Go selects the upstream provider with:
 *     hash(last 4 chars of x-opencode-session) % providers.length
 *
 * The pool size changes under load (TPM/TPS/budget filters remove
 * providers). A random session ID then remaps to a different upstream,
 * which cold-starts the prompt cache and replays the full context.
 *
 * This extension rewrites the session suffix to "uwtb". Its hash
 * (3,603,600) is divisible by every n from 1 to 16, so the session
 * always lands on slot 0 regardless of pool size. The ID prefix stays
 * untouched, so OpenCode still sees distinct sessions for usage
 * attribution and cache identity.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Suffix whose hash is divisible by every pool size from 1 to 16. */
export const PIN_SUFFIX = "uwtb";

/** Rewrite the trailing suffix of a session ID to PIN_SUFFIX. */
export function pinSessionSuffix(sessionId: string): string {
    if (sessionId.length < PIN_SUFFIX.length) return sessionId;
    return `${sessionId.slice(0, -PIN_SUFFIX.length)}${PIN_SUFFIX}`;
}

export default function opencodeSessionPinExtension(pi: ExtensionAPI) {
    pi.on("before_provider_headers", (event) => {
        const session = event.headers["x-opencode-session"];
        if (typeof session === "string") {
            event.headers["x-opencode-session"] = pinSessionSuffix(session);
        }
    });
}
