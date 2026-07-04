import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractPlanItems, isReadOnlyCommand, markCompletedSteps, type PlanItem } from "./utils.ts";

const STATE_TYPE = "plan-mode-state";
const EXECUTE_TYPE = "plan-mode-execute";

const READ_ONLY_TOOL_ORDER = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"questionnaire",
	"question",
	"ask_question",
	"ask_user_question",
	"web_search",
	"web_fetch",
];
const READ_ONLY_TOOLS = new Set(READ_ONLY_TOOL_ORDER);

type AssistantLike = {
	role: "assistant";
	content: Array<{ type: string; text?: string }>;
};

type BranchEntry = {
	type: string;
	customType?: string;
	data?: unknown;
	message?: unknown;
	content?: unknown;
	details?: unknown;
};

type StoredState = {
	version?: number;
	planModeEnabled?: boolean;
	executionMode?: boolean;
	items?: PlanItem[];
	previousActiveTools?: string[];
	executionId?: string;
};

function isAssistantMessage(message: unknown): message is AssistantLike {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { role?: unknown }).role === "assistant" &&
		Array.isArray((message as { content?: unknown }).content)
	);
}

function textFromAssistant(message: AssistantLike): string {
	return message.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function textFromEntry(entry: BranchEntry): string {
	if (entry.type === "message" && isAssistantMessage(entry.message)) return textFromAssistant(entry.message);
	return "";
}

function planModePrompt(): string {
	return `\n\n# Plan mode active
You are in read-only planning mode.

Rules:
- Inspect and reason only. Do not modify files, install packages, commit, delete, or run write operations.
- Use only active read-only tools. Bash is allowlisted to read-only commands.
- If user asks to implement, first investigate enough, then produce plan only.
- Put final plan under exactly this heading and format:

Plan:
1. Concrete step
2. Concrete step

- Do not execute plan until user approves.`;
}

function executionPrompt(items: PlanItem[]): string {
	const remaining = items.filter((item) => !item.completed).map((item) => `${item.step}. ${item.text}`).join("\n");
	return `\n\n# Approved plan execution
Execute approved plan in order.

Remaining steps:
${remaining || "(none)"}

Rules:
- After finishing step n, include marker [DONE:n] in assistant text.
- If several steps finish, include [DONE:1,2] or separate markers.
- If blocked, explain which remaining step is blocked and why.`;
}

export default function planMode(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let items: PlanItem[] = [];
	let previousActiveTools: string[] | undefined;
	let executionId: string | undefined;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only planning)",
		type: "boolean",
		default: false,
	});

	function snapshot(): StoredState {
		return {
			version: 1,
			planModeEnabled,
			executionMode,
			items: items.map((item) => ({ ...item })),
			previousActiveTools,
			executionId,
		};
	}

	function persistState(): void {
		pi.appendEntry(STATE_TYPE, snapshot());
	}

	function availableToolNames(): Set<string> {
		return new Set(pi.getAllTools().map((tool) => tool.name));
	}

	function getPlanTools(): string[] {
		const available = availableToolNames();
		const source = new Set(previousActiveTools?.length ? previousActiveTools : pi.getActiveTools());
		let tools = READ_ONLY_TOOL_ORDER.filter((name) => available.has(name) && source.has(name));
		if (tools.length === 0) tools = READ_ONLY_TOOL_ORDER.filter((name) => available.has(name));
		return tools;
	}

	function activatePlanTools(): string[] {
		const tools = getPlanTools();
		pi.setActiveTools(tools);
		return tools;
	}

	function restoreTools(): string[] {
		const available = availableToolNames();
		const restore = (previousActiveTools ?? []).filter((name) => available.has(name));
		if (restore.length > 0) {
			pi.setActiveTools(restore);
			return restore;
		}
		return pi.getActiveTools();
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (executionMode && items.length > 0) {
			const done = items.filter((item) => item.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${done}/${items.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if (executionMode && items.length > 0) {
			const visible = items.slice(0, 12).map((item) => {
				if (item.completed) {
					return ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text));
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			if (items.length > visible.length) visible.push(ctx.ui.theme.fg("dim", `… ${items.length - visible.length} more`));
			ctx.ui.setWidget("plan-mode", visible);
		} else {
			ctx.ui.setWidget("plan-mode", undefined);
		}
	}

	function enterPlanMode(ctx: ExtensionContext, options: { preserveItems?: boolean } = {}): void {
		if (!planModeEnabled) previousActiveTools = pi.getActiveTools();
		planModeEnabled = true;
		executionMode = false;
		executionId = undefined;
		if (!options.preserveItems) items = [];
		const tools = activatePlanTools();
		ctx.ui.notify(`Plan mode enabled. Tools: ${tools.join(", ") || "none"}`, "info");
		updateStatus(ctx);
		persistState();
	}

	function disablePlanMode(ctx: ExtensionContext, message = "Plan mode disabled."): void {
		planModeEnabled = false;
		executionMode = false;
		items = [];
		executionId = undefined;
		restoreTools();
		previousActiveTools = undefined;
		ctx.ui.notify(message, "info");
		updateStatus(ctx);
		persistState();
	}

	function startExecution(ctx: ExtensionContext): void {
		if (items.length === 0) {
			ctx.ui.notify("No extracted plan. Ask agent for a `Plan:` section first.", "warning");
			return;
		}

		planModeEnabled = false;
		executionMode = true;
		executionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		restoreTools();
		updateStatus(ctx);
		persistState();

		const first = items.find((item) => !item.completed);
		pi.sendMessage(
			{
				customType: EXECUTE_TYPE,
				content: `Approved plan. Execute it now. Start with step ${first?.step ?? 1}: ${first?.text ?? items[0].text}\n\nRemember to mark completed steps with [DONE:n].`,
				display: true,
				details: { executionId },
			},
			{ triggerTurn: true },
		);
	}

	function showStatus(ctx: ExtensionContext): void {
		if (items.length === 0) {
			ctx.ui.notify(planModeEnabled ? "Plan mode active. No extracted plan yet." : "Plan mode inactive.", "info");
			return;
		}
		const list = items.map((item) => `${item.step}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
		ctx.ui.notify(`Plan ${executionMode ? "execution" : "draft"}:\n${list}`, "info");
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode, or use: /plan on|off|status|execute|clear",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "enable") return enterPlanMode(ctx);
			if (action === "off" || action === "disable" || action === "cancel") return disablePlanMode(ctx);
			if (action === "status") return showStatus(ctx);
			if (action === "execute" || action === "run") return startExecution(ctx);
			if (action === "clear") {
				items = [];
				executionMode = false;
				executionId = undefined;
				updateStatus(ctx);
				persistState();
				return ctx.ui.notify("Plan cleared.", "info");
			}
			if (planModeEnabled || executionMode) return disablePlanMode(ctx);
			return enterPlanMode(ctx);
		},
	});

	pi.registerCommand("todos", {
		description: "Show current plan progress",
		handler: async (_args, ctx) => showStatus(ctx),
	});

	pi.registerShortcut("ctrl+alt+p", {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			if (planModeEnabled || executionMode) disablePlanMode(ctx);
			else enterPlanMode(ctx);
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (planModeEnabled) return { systemPrompt: event.systemPrompt + planModePrompt() };
		if (executionMode && items.length > 0) return { systemPrompt: event.systemPrompt + executionPrompt(items) };
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;
		if (!READ_ONLY_TOOLS.has(event.toolName)) {
			return { block: true, reason: `Plan mode: tool '${event.toolName}' is not read-only.` };
		}
		if (event.toolName !== "bash") return;

		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string" || !isReadOnlyCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: bash command blocked. Only read-only allowlisted commands are allowed.\nCommand: ${String(command)}`,
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || items.length === 0 || !isAssistantMessage(event.message)) return;
		const changed = markCompletedSteps(textFromAssistant(event.message), items);
		if (changed > 0) {
			updateStatus(ctx);
			persistState();
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && items.length > 0) {
			if (items.every((item) => item.completed)) {
				const doneList = items.map((item) => `✓ ${item.text}`).join("\n");
				pi.sendMessage({ customType: "plan-mode-complete", content: `Plan complete.\n\n${doneList}`, display: true }, { triggerTurn: false });
				executionMode = false;
				items = [];
				executionId = undefined;
				previousActiveTools = undefined;
				updateStatus(ctx);
				persistState();
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;

		const extracted = extractPlanItems(textFromAssistant(lastAssistant));
		if (extracted.length === 0) return;
		items = extracted;
		persistState();

		const list = items.map((item) => `${item.step}. ☐ ${item.text}`).join("\n");
		pi.sendMessage({ customType: "plan-mode-list", content: `Plan steps:\n\n${list}`, display: true }, { triggerTurn: false });

		const choice = await ctx.ui.select("Plan ready", ["Execute plan", "Stay in plan mode", "Refine plan", "Disable plan mode"]);
		if (choice === "Execute plan") return startExecution(ctx);
		if (choice === "Disable plan mode") return disablePlanMode(ctx);
		if (choice === "Refine plan") {
			const refinement = await ctx.ui.editor("Refine plan:", "");
			if (refinement?.trim()) pi.sendUserMessage(refinement.trim());
		}
		updateStatus(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch() as BranchEntry[];
		const latestState = [...branch]
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === STATE_TYPE)?.data as StoredState | undefined;

		if (latestState) {
			planModeEnabled = latestState.planModeEnabled ?? false;
			executionMode = latestState.executionMode ?? false;
			items = (latestState.items ?? []).map((item) => ({ ...item }));
			previousActiveTools = latestState.previousActiveTools;
			executionId = latestState.executionId;
		}

		if (pi.getFlag("plan") === true) {
			if (!previousActiveTools?.length) previousActiveTools = pi.getActiveTools();
			planModeEnabled = true;
			executionMode = false;
			items = [];
			executionId = undefined;
		}

		if (executionMode && items.length > 0 && executionId) {
			const executeIndex = branch.findIndex(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === EXECUTE_TYPE &&
					(entry.details as { executionId?: string } | undefined)?.executionId === executionId,
			);
			const scan = executeIndex >= 0 ? branch.slice(executeIndex + 1) : branch;
			markCompletedSteps(scan.map(textFromEntry).join("\n"), items);
		}

		if (planModeEnabled) {
			if (!previousActiveTools?.length) previousActiveTools = pi.getActiveTools();
			activatePlanTools();
		} else if (executionMode) {
			restoreTools();
		}
		updateStatus(ctx);
	});
}
