/**
 * Read tool override - directory awareness
 *
 * Overrides the built-in `read` tool to handle directory paths gracefully.
 * When the agent tries to read a directory, this delegates to the native `ls`
 * tool instead of failing with an error.
 *
 * For regular files, behavior is identical to the built-in read tool.
 *
 * Usage:
 *   pi -e ./tool-override.ts
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLsTool, createReadTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

function resolvePath(filePath: string, cwd: string): string {
    let p = filePath.startsWith("@") ? filePath.slice(1) : filePath;
    if (p === "~" || p.startsWith("~/")) {
        p = homedir() + p.slice(1);
    }
    return isAbsolute(p) ? p : resolve(cwd, p);
}

const readSchema = Type.Object({
    path: Type.String({
        description: "Path to the file to read (relative or absolute)",
    }),
    offset: Type.Optional(
        Type.Number({
            description: "Line number to start reading from (1-indexed)",
        }),
    ),
    limit: Type.Optional(
        Type.Number({ description: "Maximum number of lines to read" }),
    ),
});

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "read",
        label: "read",
        description:
            "Read the contents of a file with access logging. Some sensitive paths (.env, secrets, credentials) are blocked.",
        parameters: readSchema,

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const { path, offset, limit } = params;
            const absolutePath = resolvePath(path, ctx.cwd);

            let isDir = false;
            try {
                const s = await stat(absolutePath);
                isDir = s.isDirectory();
            } catch {
                // Path doesn't exist or can't be stat'd; let the read tool handle the error
            }

            if (isDir) {
                const lsTool = createLsTool(ctx.cwd);
                const result = await lsTool.execute(
                    toolCallId,
                    { path },
                    signal,
                    onUpdate,
                );
                const note = `[Note: "${path}" is a directory, listing contents via ls]\n\n`;
                if (result.content?.[0]?.type === "text") {
                    result.content[0].text = note + result.content[0].text;
                }
                return result;
            }

            const readTool = createReadTool(ctx.cwd);
            return readTool.execute(
                toolCallId,
                { path, offset, limit },
                signal,
                onUpdate,
            );
        },
    });
}
