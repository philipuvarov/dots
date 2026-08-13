import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_FILE = join(getAgentDir(), "fast-mode.json");
const STATUS_ID = "fast-mode";
const SUPPORTED_APIS = new Set(["openai-responses", "openai-codex-responses", "openai-completions"]);

interface FastModeState {
	enabled: boolean;
}

function supportsFastMode(ctx: ExtensionContext): boolean {
	return SUPPORTED_APIS.has(ctx.model?.api ?? "");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadState(): FastModeState {
	try {
		const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<FastModeState>;
		return { enabled: state.enabled === true };
	} catch {
		return { enabled: false };
	}
}

function saveState(state: FastModeState): void {
	const temporaryFile = `${STATE_FILE}.tmp`;
	writeFileSync(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	renameSync(temporaryFile, STATE_FILE);
}

export default function fastModeExtension(pi: ExtensionAPI): void {
	let enabled = false;

	function updateStatus(ctx: ExtensionContext): void {
		const label = enabled ? "⚡ fast:on" : "fast:off";
		const color = enabled ? "warning" : "dim";
		ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg(color, label));
	}

	function setEnabled(next: boolean, ctx: ExtensionContext): void {
		enabled = next;
		updateStatus(ctx);

		try {
			saveState({ enabled });
		} catch (error) {
			ctx.ui.notify(`Could not save Fast mode setting: ${String(error)}`, "error");
		}

		if (enabled && !supportsFastMode(ctx)) {
			ctx.ui.notify(
				`Fast mode enabled, but ${ctx.model?.provider ?? "current provider"}/${ctx.model?.id ?? "current model"} does not use a supported OpenAI API.`,
				"warning",
			);
			return;
		}

		ctx.ui.notify(`Fast mode ${enabled ? "enabled" : "disabled"}.`, "info");
	}

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Fast mode (usage billed at Fast mode rates)",
		getArgumentCompletions: (prefix) => {
			const values = ["on", "off", "status"];
			const matches = values.filter((value) => value.startsWith(prefix.trim().toLowerCase()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			switch (action) {
				case "":
					setEnabled(!enabled, ctx);
					break;
				case "on":
					setEnabled(true, ctx);
					break;
				case "off":
					setEnabled(false, ctx);
					break;
				case "status":
					ctx.ui.notify(`Fast mode is ${enabled ? "enabled" : "disabled"}.`, "info");
					break;
				default:
					ctx.ui.notify("Usage: /fast [on|off|status]", "error");
			}
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !supportsFastMode(ctx) || !isObject(event.payload)) return;

		// OpenAI renamed Priority processing to Fast mode. `priority` remains the
		// compatible wire value and lets pi account for the Fast mode price uplift.
		return { ...event.payload, service_tier: "priority" };
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		enabled = loadState().enabled;
		updateStatus(ctx);
	});
}
