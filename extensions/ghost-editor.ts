/**
 * Ghost Editor Extension
 *
 * Provides a custom editor component that renders ghost text (dimmed inline
 * suggestions) after the cursor. Other extensions communicate with it via
 * the shared EventBus.
 *
 * EventBus protocol:
 * - "ghost-text:set"   (string)          -- set ghost text to display
 * - "ghost-text:clear" (undefined)       -- clear the ghost text
 * - "ghost-text:accept" (undefined)      -- emitted when user accepts ghost text via Tab
 *
 * Behaviour:
 * - Ghost text is rendered in dim color after the cursor when the editor is empty.
 * - Tab accepts the ghost text (inserts it into the editor).
 * - Any printable input clears the ghost text.
 * - Escape clears the ghost text (then passes through to app handling).
 */

import {
    CustomEditor,
    type ExtensionAPI,
    type KeybindingsManager,
} from "@mariozechner/pi-coding-agent";
import {
    type EditorTheme,
    matchesKey,
    type TUI,
    visibleWidth,
} from "@mariozechner/pi-tui";

const REVERSE_VIDEO_SPACE = "\x1b[7m \x1b[0m";

export const GHOST_TEXT_SET = "ghost-text:set";
export const GHOST_TEXT_CLEAR = "ghost-text:clear";
export const GHOST_TEXT_ACCEPT = "ghost-text:accept";

class GhostTextEditor extends CustomEditor {
    private ghostText: string | null = null;
    private dimStyle: (text: string) => string;
    private onGhostAccept: () => void;
    private tuiRef: TUI;

    constructor(
        tui: TUI,
        theme: EditorTheme,
        keybindings: KeybindingsManager,
        dimStyle: (text: string) => string,
        onGhostAccept: () => void,
    ) {
        super(tui, theme, keybindings);
        this.tuiRef = tui;
        this.dimStyle = dimStyle;
        this.onGhostAccept = onGhostAccept;
    }

    setGhostText(text: string | null): void {
        this.ghostText = text;
        this.tuiRef.requestRender();
    }

    handleInput(data: string): void {
        if (this.ghostText) {
            // Tab: accept ghost text when editor is empty
            if (matchesKey(data, "tab")) {
                if (this.getText().trim() === "") {
                    const text = this.ghostText;
                    this.ghostText = null;
                    this.setText(text);
                    this.onGhostAccept();
                    return;
                }
            }

            // Escape: clear ghost text, then pass through
            if (matchesKey(data, "escape")) {
                this.ghostText = null;
                super.handleInput(data);
                return;
            }

            // Any printable input clears ghost text
            if (data.length === 1 && data.charCodeAt(0) >= 32) {
                this.ghostText = null;
            }

            // Backspace/delete on empty editor clears ghost text
            if (
                (matchesKey(data, "backspace") || matchesKey(data, "delete")) &&
                this.getText() === ""
            ) {
                this.ghostText = null;
                return;
            }
        }

        super.handleInput(data);
    }

    render(width: number): string[] {
        const lines = super.render(width);

        if (!this.ghostText || this.getText() !== "") {
            return lines;
        }

        // The render output structure is:
        //   [0]     top border
        //   [1..n]  content lines (with padding)
        //   [n+1]   bottom border
        //   [n+2..] autocomplete (optional)
        //
        // When the editor is empty, there is exactly one content line (index 1)
        // containing the cursor (reverse-video space) and trailing padding.
        //
        // We inject dimmed ghost text right after the cursor on that line.

        if (lines.length < 3) return lines;

        const cursorLineIndex = 1;
        const line = lines[cursorLineIndex]!;

        // Find the reverse-video cursor block in the rendered line.
        // The cursor is: \x1b[7m \x1b[0m  (reverse video space then reset)
        const cursorEnd = line.indexOf(REVERSE_VIDEO_SPACE);
        if (cursorEnd === -1) return lines;

        const afterCursorPos = cursorEnd + REVERSE_VIDEO_SPACE.length;
        const beforeGhost = line.slice(0, afterCursorPos);
        const afterGhost = line.slice(afterCursorPos);

        // Calculate how much ghost text fits in the remaining width.
        // afterGhost is all padding spaces; its visible width tells us the budget.
        const availableWidth = visibleWidth(afterGhost);
        if (availableWidth <= 0) return lines;

        // Truncate ghost text to fit, leaving room for "[Tab]" hint
        const hintText = " [Tab]";
        const hintWidth = hintText.length;
        const maxGhostWidth = availableWidth - hintWidth;

        if (maxGhostWidth <= 0) return lines;

        const ghostDisplay =
            this.ghostText.length > maxGhostWidth
                ? `${this.ghostText.slice(0, maxGhostWidth - 1)}\u2026`
                : this.ghostText;

        const ghostWidth = visibleWidth(ghostDisplay);
        const hintDisplay = ghostWidth + hintWidth <= availableWidth ? hintText : "";
        const totalInserted = ghostWidth + visibleWidth(hintDisplay);
        const remainingPadding = Math.max(0, availableWidth - totalInserted);

        lines[cursorLineIndex] =
            beforeGhost +
            this.dimStyle(ghostDisplay + hintDisplay) +
            " ".repeat(remainingPadding);

        return lines;
    }
}

export default function ghostEditorExtension(pi: ExtensionAPI) {
    let editor: GhostTextEditor | null = null;
    let unsubSet: (() => void) | null = null;
    let unsubClear: (() => void) | null = null;

    function bindEventBus() {
        // Clean up previous subscriptions to avoid accumulation across sessions
        unsubSet?.();
        unsubClear?.();

        unsubSet = pi.events.on(GHOST_TEXT_SET, (data) => {
            if (editor && typeof data === "string") {
                editor.setGhostText(data);
            }
        });

        unsubClear = pi.events.on(GHOST_TEXT_CLEAR, () => {
            if (editor) {
                editor.setGhostText(null);
            }
        });
    }

    pi.on("session_start", (_event, ctx) => {
        if (!ctx.hasUI) return;

        const dimStyle = (text: string) => ctx.ui.theme.fg("dim", text);

        ctx.ui.setEditorComponent((tui, theme, kb) => {
            editor = new GhostTextEditor(tui, theme, kb, dimStyle, () => {
                pi.events.emit(GHOST_TEXT_ACCEPT, undefined);
            });
            return editor;
        });

        bindEventBus();
    });
}
