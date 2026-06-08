/**
 * /fu -- Send a follow-up message to the agent.
 *
 * Queues a user message that will be delivered after the agent finishes
 * its current work. If the agent is idle, sends immediately.
 *
 * Usage:
 *   /fu now fix the tests
 *   /fu summarize what you did
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
    pi.registerCommand("fu", {
        description: "Send a follow-up message (queued until agent is idle)",
        handler: async (args, ctx) => {
            const message = args.trim();
            if (!message) {
                ctx.ui.notify("Usage: /fu <message>", "warning");
                return;
            }

            if (ctx.isIdle()) {
                pi.sendUserMessage(message);
            } else {
                pi.sendUserMessage(message, { deliverAs: "followUp" });
            }
        },
    });
}
