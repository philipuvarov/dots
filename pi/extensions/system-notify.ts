import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";

const PATCHED = Symbol.for("pi-system-notify-ui-patched");
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

type UiWithPatch = ExtensionContext["ui"] & { [PATCHED]?: boolean } & Record<string, unknown>;

let terminalFocused: boolean | undefined;
let focusTrackingInstalled = false;

function suppressWhenFocused(): boolean {
	return process.env.PI_SYSTEM_NOTIFY_SUPPRESS_FOCUSED !== "0";
}

function canNotify(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui";
}

function notify(title: string, body: string): void {
	if (suppressWhenFocused() && terminalFocused === true) return;

	if (process.platform === "darwin") {
		execFile("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], () => {});
	} else if (process.platform === "linux") {
		execFile("notify-send", [title, body], () => {});
	}
}

function onStdinData(data: Buffer | string): void {
	const text = Buffer.isBuffer(data) ? data.toString("utf8") : data;
	const lastFocusIn = text.lastIndexOf(FOCUS_IN);
	const lastFocusOut = text.lastIndexOf(FOCUS_OUT);
	if (lastFocusIn === -1 && lastFocusOut === -1) return;
	terminalFocused = lastFocusIn > lastFocusOut;
}

function installFocusTracking(ctx: ExtensionContext): void {
	if (focusTrackingInstalled || ctx.mode !== "tui" || !process.stdin.isTTY || !process.stdout.isTTY) return;
	terminalFocused = true;
	process.stdout.write("\x1b[?1004h");
	process.stdin.on("data", onStdinData);
	focusTrackingInstalled = true;
}

function uninstallFocusTracking(): void {
	if (!focusTrackingInstalled) return;
	process.stdin.off("data", onStdinData);
	if (process.stdout.isTTY) process.stdout.write("\x1b[?1004l");
	focusTrackingInstalled = false;
	terminalFocused = undefined;
}

function patchUiPrompts(ctx: ExtensionContext): void {
	if (!canNotify(ctx) || !ctx.hasUI) return;

	const ui = ctx.ui as UiWithPatch;
	if (ui[PATCHED]) return;
	ui[PATCHED] = true;

	for (const method of ["select", "confirm", "input", "editor", "custom"] as const) {
		const original = ui[method];
		if (typeof original !== "function") continue;

		ui[method] = function wrappedUiPrompt(this: unknown, ...args: unknown[]) {
			notify("Pi", "Waiting for your input");
			return original.apply(this, args);
		} as typeof original;
	}
}

export default function systemNotify(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		installFocusTracking(ctx);
		patchUiPrompts(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!canNotify(ctx)) return;
		notify("Pi", "Job finished");
	});

	pi.on("session_shutdown", async () => {
		uninstallFocusTracking();
	});
}
