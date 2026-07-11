import { isToolCallEventType, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type KeybindingsManager, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type DangerousMatch, findDangerousCommandMatches, findToolPathMatches, formatReasons, formatToolRequest, unique } from "./analysis.ts";

export { findDangerousCommandMatches, findToolPathMatches } from "./analysis.ts";

const PROCEED = "Proceed";
const BLOCK = "Block";
const MAX_COMMAND_CHARS = 4_000;
const GUARDRAIL_DIALOG_MAX_ROWS = 40;
const GUARDRAIL_DIALOG_MIN_PREVIEW_ROWS = 3;

export default function dangerGuardrail(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command;
			const matches = findDangerousCommandMatches(command, 0, ctx.cwd);
			if (matches.length === 0) return;

			const reason = formatReasons(matches);
			if (!ctx.hasUI) {
				return { block: true, reason: `Dangerous command blocked; no UI available to confirm. ${reason}` };
			}

			const allowed = await askToProceed(ctx, command, matches, "agent bash tool", "Command");
			if (!allowed) return { block: true, reason: `Dangerous command blocked by user. ${reason}` };
			return;
		}

		const pathMatches = findToolPathMatches(event.toolName, event.input, ctx.cwd);
		if (pathMatches.length === 0) return;

		const reason = formatReasons(pathMatches);
		if (!ctx.hasUI) {
			return { block: true, reason: `Sensitive filesystem access blocked; no UI available to confirm. ${reason}` };
		}

		const allowed = await askToProceed(ctx, formatToolRequest(event.toolName, event.input), pathMatches, `${event.toolName} tool`, "Request");
		if (!allowed) return { block: true, reason: `Sensitive filesystem access blocked by user. ${reason}` };
	});

	pi.on("user_bash", async (event, ctx) => {
		const matches = findDangerousCommandMatches(event.command, 0, ctx.cwd);
		if (matches.length === 0) return;

		const reason = formatReasons(matches);
		if (!ctx.hasUI) {
			return blockedUserBashResult(`Dangerous command blocked; no UI available to confirm. ${reason}`);
		}

		const allowed = await askToProceed(ctx, event.command, matches, "user bash command", "Command");
		if (!allowed) return blockedUserBashResult(`Dangerous command blocked by user. ${reason}`);
	});
}

function blockedUserBashResult(output: string) {
	return {
		result: {
			output,
			exitCode: 1,
			cancelled: false,
			truncated: false,
		},
	};
}

async function askToProceed(
	ctx: ExtensionContext,
	command: string,
	matches: DangerousMatch[],
	source: string,
	previewLabel: string,
): Promise<boolean> {
	const reasons = unique(matches.map((match) => match.reason)).slice(0, 2);
	const preview = truncateCommand(command);

	if (ctx.mode === "tui") {
		return ctx.ui.custom<boolean>((tui, theme, keybindings, done) => new GuardrailDialog({
			command: preview,
			done,
			keybindings,
			previewLabel,
			reasons,
			requestRender: () => tui.requestRender(),
			rowCount: () => tui.terminal.rows,
			source,
			theme,
		}));
	}

	const message = [
		`Dangerous ${source} detected.`,
		"",
		"Why flagged:",
		...reasons.map((reason) => `- ${reason}`),
		"",
		`${previewLabel}:`,
		indent(preview),
		"",
		"Proceed anyway? Default is Block.",
	].join("\n");

	const choice = await ctx.ui.select(message, [BLOCK, PROCEED]);
	return choice === PROCEED;
}

class GuardrailDialog implements Component {
	private readonly commandText: string;
	private commandLines: string[] = [""];
	private commandWrapWidth = 0;
	private scrollOffset = 0;
	private selectedIndex = 0;
	private lastPreviewRows = GUARDRAIL_DIALOG_MIN_PREVIEW_ROWS;

	constructor(private readonly props: {
		command: string;
		done: (value: boolean) => void;
		keybindings: KeybindingsManager;
		previewLabel: string;
		reasons: string[];
		requestRender: () => void;
		rowCount: () => number;
		source: string;
		theme: Theme;
	}) {
		this.commandText = sanitizeForTerminal(props.command);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		const innerWidth = Math.max(10, safeWidth - 2);
		this.ensureCommandWrap(Math.max(1, safeWidth - 2));
		const maxRows = Math.max(12, Math.min(GUARDRAIL_DIALOG_MAX_ROWS, this.props.rowCount() - 2));
		const headerLines = this.headerLines(innerWidth);
		const footerLines = this.footerLines(innerWidth);
		const fixedRows = 2 + headerLines.length + footerLines.length;
		this.lastPreviewRows = Math.max(
			GUARDRAIL_DIALOG_MIN_PREVIEW_ROWS,
			Math.min(this.commandLines.length || 1, maxRows - fixedRows),
		);
		this.clampScroll();

		const end = Math.min(this.commandLines.length, this.scrollOffset + this.lastPreviewRows);
		const preview = this.commandLines.slice(this.scrollOffset, end);
		while (preview.length < this.lastPreviewRows) preview.push("");

		const lines = [
			this.border(safeWidth),
			...headerLines,
			...preview.map((line) => this.fit(`  ${line}`, safeWidth)),
			...footerLines,
			this.border(safeWidth),
		];
		return lines.map((line) => this.fit(line, safeWidth));
	}

	handleInput(data: string): void {
		const kb = this.props.keybindings;
		if (kb.matches(data, "tui.select.cancel")) {
			this.props.done(false);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.props.done(this.selectedIndex === 1);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.scrollBy(-this.lastPreviewRows);
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.scrollBy(this.lastPreviewRows);
			return;
		}
		if (kb.matches(data, "tui.select.up") || data === "k") {
			this.scrollBy(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down") || data === "j") {
			this.scrollBy(1);
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLeft") || data === "h") {
			this.select(0);
			return;
		}
		if (kb.matches(data, "tui.editor.cursorRight") || data === "l" || kb.matches(data, "tui.input.tab") || data === " ") {
			this.select(this.selectedIndex === 0 ? 1 : 0);
			return;
		}
		if (data === "b" || data === "B") this.props.done(false);
		else if (data === "p" || data === "P") this.props.done(true);
	}

	invalidate(): void {}

	private headerLines(width: number): string[] {
		const theme = this.props.theme;
		const lines = [
			...wrapStyled(theme.fg("accent", theme.bold(`Dangerous ${this.props.source} detected.`)), width, "  "),
			"",
			theme.fg("warning", "  Why flagged:"),
		];
		for (const reason of this.props.reasons) {
			lines.push(...wrapStyled(theme.fg("text", `- ${reason}`), Math.max(10, width - 2), "  "));
		}
		lines.push("");
		lines.push(theme.fg("muted", `  ${this.props.previewLabel} preview (${this.scrollInfo()}):`));
		return lines.map((line) => this.fit(line, width + 2));
	}

	private footerLines(width: number): string[] {
		const theme = this.props.theme;
		const block = this.option(BLOCK, 0, "text");
		const proceed = this.option(PROCEED, 1, "warning");
		return [
			"",
			this.fit(`  ${block}  ${proceed}`, width + 2),
			theme.fg("dim", "  ↑↓/PgUp/PgDn scroll · Tab/←→ choose · Enter confirm · Esc block · p proceed"),
		];
	}

	private option(label: string, index: number, color: "text" | "warning"): string {
		const theme = this.props.theme;
		const text = ` ${label} `;
		if (this.selectedIndex === index) return theme.bg("selectedBg", theme.fg(color, theme.bold(text)));
		return theme.fg(color, text);
	}

	private scrollInfo(): string {
		if (this.commandLines.length <= this.lastPreviewRows) return `${this.commandLines.length} line${this.commandLines.length === 1 ? "" : "s"}`;
		const start = this.scrollOffset + 1;
		const end = Math.min(this.commandLines.length, this.scrollOffset + this.lastPreviewRows);
		return `${start}-${end}/${this.commandLines.length} lines`;
	}

	private scrollBy(delta: number): void {
		this.scrollOffset += delta;
		this.clampScroll();
		this.props.requestRender();
	}

	private select(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(1, index));
		this.props.requestRender();
	}

	private clampScroll(): void {
		const maxOffset = Math.max(0, this.commandLines.length - this.lastPreviewRows);
		this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset));
	}

	private ensureCommandWrap(width: number): void {
		if (this.commandWrapWidth === width) return;
		this.commandWrapWidth = width;
		this.commandLines = wrapPlainLines(this.commandText, width);
		this.clampScroll();
	}

	private border(width: number): string {
		return this.props.theme.fg("borderMuted", "─".repeat(width));
	}

	private fit(line: string, width: number): string {
		return truncateToWidth(line, width, "");
	}
}

function wrapStyled(text: string, width: number, prefix = ""): string[] {
	const lineWidth = Math.max(1, width - prefix.length);
	return wrapTextWithAnsi(text, lineWidth).map((line) => `${prefix}${line}`);
}

function wrapPlainLines(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const physicalLine of text.split("\n")) {
		if (physicalLine.length === 0) {
			lines.push("");
			continue;
		}
		lines.push(...wrapTextWithAnsi(physicalLine, Math.max(1, width)));
	}
	return lines.length > 0 ? lines : [""];
}

function sanitizeForTerminal(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/\x1b/g, "␛")
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function truncateCommand(command: string): string {
	if (command.length <= MAX_COMMAND_CHARS) return command;
	return `${command.slice(0, MAX_COMMAND_CHARS)}\n...[command truncated]`;
}

function indent(text: string): string {
	return text.split(/\r?\n/).map((line) => `  ${line}`).join("\n");
}
