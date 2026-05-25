/**
 * /back - Navigate back to the last user message in the current branch.
 *
 * Only works when the agent is idle. Navigates the conversation tree
 * to the most recent user message, allowing the user to re-branch.
 *
 * Usage:
 *   /back                    - navigate without summary
 *   /back summary            - navigate and summarize the skipped portion
 *   /back summary <prompt>   - navigate and summarize with custom instructions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
    pi.registerCommand("back", {
        description:
            "Navigate back to the last user message. Use /back summary [prompt] to include a summary",
        getArgumentCompletions: (prefix) => {
            const options = ["summary"];
            const filtered = options.filter((o) => o.startsWith(prefix));
            return filtered.length > 0
                ? filtered.map((o) => ({ value: o, label: o }))
                : null;
        },
        handler: async (args, ctx) => {
            if (!ctx.isIdle()) {
                ctx.ui.notify("Cannot navigate while agent is running", "warning");
                return;
            }
            const trimmed = args.trim();
            const firstWord = trimmed.split(/\s/, 1)[0].toLowerCase();
            if (trimmed && firstWord !== "summary") {
                ctx.ui.notify(
                    "Unknown argument. Usage: /back [summary [prompt]]",
                    "warning",
                );
                return;
            }
            const summarize = firstWord === "summary";
            const customInstructions =
                trimmed.slice(firstWord.length).trim() || undefined;
            const entries = ctx.sessionManager.getBranch();
            const userMessages = entries.filter(
                (e) => e.type === "message" && e.message.role === "user",
            );

            if (userMessages.length === 0) {
                ctx.ui.notify("No previous user message to navigate to", "warning");
                return;
            }

            const target = userMessages[userMessages.length - 1];
            await ctx.navigateTree(target.id, { summarize, customInstructions });
        },
    });
}
