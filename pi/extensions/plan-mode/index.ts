import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { extractPlanItems, formatPlanItem, isReadOnlyCommand, markCompletedSteps, type PlanItem } from "./utils.ts";

const STATE_TYPE = "plan-mode-state";
const EXECUTE_TYPE = "plan-mode-execute";
const PLAN_CARD_TYPE = "plan-mode-card";
const SUBMIT_PLAN_TOOL = "submit_plan";

const PLANNING_CONTEXT_TYPE = "plan-mode-context-v2";
const EXECUTION_CONTEXT_TYPE = "plan-mode-execution-context-v2";
const NORMAL_CONTEXT_TYPE = "plan-mode-normal-context-v2";

const MANAGED_CONTEXT_TYPES = new Set([
	PLANNING_CONTEXT_TYPE,
	EXECUTION_CONTEXT_TYPE,
	NORMAL_CONTEXT_TYPE,
	EXECUTE_TYPE,
	// Entries produced by older versions. Keep them visible in the transcript,
	// but never let them keep controlling future model turns.
	"plan-mode-context",
	"plan-execution-context",
	"plan-mode-list",
	"plan-mode-complete",
	"plan-todo-list",
	"plan-complete",
]);

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
	SUBMIT_PLAN_TOOL,
];
const READ_ONLY_TOOLS = new Set(READ_ONLY_TOOL_ORDER);

const submitPlanSchema = Type.Object({
	steps: Type.Array(
		Type.Object({
			title: Type.String({
				description: "Concise imperative step title, ideally under 90 characters",
				minLength: 4,
				maxLength: 120,
			}),
			details: Type.Optional(
				Type.String({
					description: "Optional implementation detail, relevant files, constraints, or verification notes",
					maxLength: 800,
				}),
			),
		}),
		{
			description: "Ordered implementation steps. Consolidate the plan into at most eight meaningful steps.",
			minItems: 1,
			maxItems: 8,
		},
	),
});

type AssistantLike = {
	role: "assistant";
	content: Array<{ type: string; text?: string }>;
};

type BranchEntry = {
	type: string;
	customType?: string;
	data?: unknown;
	message?: unknown;
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

type PlanCardData = {
	title: string;
	items: PlanItem[];
	completed?: boolean;
};

type SubmitPlanDetails = {
	items: PlanItem[];
};

function isAssistantMessage(message: unknown): message is AssistantLike {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { role?: unknown }).role === "assistant" &&
		Array.isArray((message as { content?: unknown }).content)
	);
}

function textFromAssistant(message: unknown): string {
	if (!isAssistantMessage(message)) return "";
	return message.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function textFromEntry(entry: BranchEntry): string {
	if (entry.type === "message" && isAssistantMessage(entry.message)) return textFromAssistant(entry.message);
	return "";
}

function customTypeOf(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const customType = (message as { customType?: unknown }).customType;
	return typeof customType === "string" ? customType : undefined;
}

function cleanSubmittedText(value: string, maxLength: number): string {
	return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function formatPromptItem(item: PlanItem): string {
	return item.details ? `${item.step}. ${item.text}\n   Details: ${item.details}` : `${item.step}. ${item.text}`;
}

function planningContext(structuredSubmission: boolean): string {
	const finalization = structuredSubmission
		? `- Finish by calling ${SUBMIT_PLAN_TOOL} exactly once, as the only tool call in that final turn.
- Submit 3-8 meaningful implementation steps with concise imperative titles.
- Put paths, rationale, constraints, and verification notes in each step's optional details instead of making titles long.
- Do not print a Markdown numbered plan when ${SUBMIT_PLAN_TOOL} is available.`
		: `- Finish with a short \`Plan:\` numbered list containing 3-8 meaningful implementation steps.
- Keep each numbered step to one concise sentence. Do not use nested lists or code blocks.`;

	return `[PI PLAN MODE: ACTIVE]
You are in read-only planning mode.

Rules:
- Inspect, reason, and ask focused questions only. Do not modify files, install packages, commit, delete, or perform write operations.
- Use only the active read-only tools. Bash is restricted by an allowlist.
- Investigate enough to make the plan specific to this repository.
- Do not implement until the user explicitly approves the plan.

Finalization:
${finalization}`;
}

function executionContext(items: PlanItem[]): string {
	const remaining = items.filter((item) => !item.completed).map(formatPromptItem).join("\n");
	return `[PI PLAN MODE: EXECUTION APPROVED]
Plan mode is no longer read-only. Execute the approved plan using the currently available tools.

Remaining steps:
${remaining || "(none)"}

Rules:
- Work through the remaining steps in order unless dependencies require otherwise.
- After finishing step n, include [DONE:n] in assistant text.
- For several completed steps, use [DONE:1,2] or separate markers.
- If blocked, identify the blocked step and explain why.`;
}

function normalContext(): string {
	return `[PI PLAN MODE: INACTIVE]
Plan mode is off. Treat any earlier plan-mode instruction or read-only refusal as stale. Follow the user's current request using the currently available tools. Plan mode imposes no read-only restriction; when implementation is requested and mutation tools are available, use them. Do not keep producing plans unless the user asks for one.`;
}

export default function planMode(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let items: PlanItem[] = [];
	let previousActiveTools: string[] | undefined;
	let normalToolFallback: string[] = [];
	let executionId: string | undefined;
	let planSubmittedForRun = false;
	let structuredPlanEnabled = true;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only planning)",
		type: "boolean",
		default: false,
	});

	function cloneItems(source = items): PlanItem[] {
		return source.map((item) => ({ ...item }));
	}

	function snapshot(): StoredState {
		return {
			version: 2,
			planModeEnabled,
			executionMode,
			items: cloneItems(),
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

	function withoutInternalTools(toolNames: string[]): string[] {
		return [...new Set(toolNames.filter((name) => name !== SUBMIT_PLAN_TOOL))];
	}

	function getPlanTools(): string[] {
		const available = availableToolNames();
		const sourceNames = previousActiveTools?.length
			? previousActiveTools
			: normalToolFallback.length
				? normalToolFallback
				: withoutInternalTools(pi.getActiveTools());
		const source = new Set(sourceNames);
		let tools = READ_ONLY_TOOL_ORDER.filter(
			(name) =>
				available.has(name) &&
				(name === SUBMIT_PLAN_TOOL ? structuredPlanEnabled : source.has(name)),
		);
		const internalToolCount = structuredPlanEnabled && available.has(SUBMIT_PLAN_TOOL) ? 1 : 0;
		if (tools.length <= internalToolCount) {
			tools = READ_ONLY_TOOL_ORDER.filter(
				(name) => available.has(name) && (name !== SUBMIT_PLAN_TOOL || structuredPlanEnabled),
			);
		}
		return tools;
	}

	function activatePlanTools(): string[] {
		const tools = getPlanTools();
		pi.setActiveTools(tools);
		return tools;
	}

	function restoreTools(): string[] {
		const available = availableToolNames();
		const source = previousActiveTools?.length ? previousActiveTools : normalToolFallback;
		let restore = withoutInternalTools(source).filter((name) => available.has(name));
		if (restore.length === 0) {
			restore = withoutInternalTools(pi.getActiveTools()).filter((name) => available.has(name));
		}
		pi.setActiveTools(restore);
		normalToolFallback = [...restore];
		return restore;
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
			const visible = items.slice(0, 10).map((item) => {
				const label = formatPlanItem(item, 96);
				if (item.completed) {
					return ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(label));
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${label}`;
			});
			if (items.length > visible.length) visible.push(ctx.ui.theme.fg("dim", `… ${items.length - visible.length} more`));
			ctx.ui.setWidget("plan-mode", visible);
		} else {
			ctx.ui.setWidget("plan-mode", undefined);
		}
	}

	function enterPlanMode(ctx: ExtensionContext, options: { preserveItems?: boolean } = {}): void {
		if (!planModeEnabled) {
			previousActiveTools = withoutInternalTools(pi.getActiveTools());
			normalToolFallback = [...previousActiveTools];
		}
		planModeEnabled = true;
		executionMode = false;
		executionId = undefined;
		planSubmittedForRun = false;
		if (!options.preserveItems) items = [];
		const tools = activatePlanTools();
		ctx.ui.notify(`Plan mode enabled. Tools: ${tools.join(", ") || "none"}`, "info");
		updateStatus(ctx);
		persistState();
	}

	function disablePlanMode(ctx: ExtensionContext, message = "Plan mode disabled. Full access restored."): void {
		planModeEnabled = false;
		executionMode = false;
		items = [];
		executionId = undefined;
		planSubmittedForRun = false;
		restoreTools();
		previousActiveTools = undefined;
		ctx.ui.notify(message, "info");
		updateStatus(ctx);
		persistState();
	}

	function startExecution(ctx: ExtensionContext): void {
		if (items.length === 0) {
			ctx.ui.notify("No submitted plan. Create one in plan mode first.", "warning");
			return;
		}

		planModeEnabled = false;
		executionMode = true;
		planSubmittedForRun = false;
		executionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const restored = restoreTools();
		updateStatus(ctx);
		persistState();
		ctx.ui.notify(`Plan approved. Restored tools: ${restored.join(", ") || "none"}`, "info");

		pi.sendMessage(
			{
				customType: EXECUTE_TYPE,
				content: executionContext(items),
				display: false,
				details: { executionId },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function showStatus(ctx: ExtensionContext): void {
		if (items.length === 0) {
			ctx.ui.notify(planModeEnabled ? "Plan mode active. No plan submitted yet." : "Plan mode inactive.", "info");
			return;
		}
		const list = items
			.map((item) => `${item.step}. ${item.completed ? "✓" : "○"} ${formatPlanItem(item, 110)}`)
			.join("\n");
		ctx.ui.notify(`Plan ${executionMode ? "execution" : "draft"}:\n${list}`, "info");
	}

	pi.registerEntryRenderer<PlanCardData>(PLAN_CARD_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data ?? { title: "Plan", items: [] };
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const titleColor = data.completed ? "success" : "accent";
		box.addChild(new Text(theme.fg(titleColor, theme.bold(data.title)), 0, 0));

		const lines = data.items.map((item) => {
			const marker = data.completed || item.completed ? "✓" : "○";
			const color = data.completed || item.completed ? "success" : "text";
			let line = `${theme.fg(color, `${marker} ${item.step}.`)} ${formatPlanItem(item, 100)}`;
			if (expanded && item.details) line += `\n   ${theme.fg("muted", item.details)}`;
			return line;
		});
		box.addChild(new Text(lines.join("\n"), 0, 0));
		if (!expanded && data.items.some((item) => item.details)) {
			box.addChild(new Text(theme.fg("dim", "Expand to show implementation details."), 0, 0));
		}
		return box;
	});

	pi.registerTool({
		name: SUBMIT_PLAN_TOOL,
		label: "Submit Plan",
		description:
			"Submit the final implementation plan for interactive user approval. Call only in active plan mode, after investigation, and as the sole final tool call.",
		promptSnippet: "Submit a concise final plan for interactive approval (plan mode only)",
		promptGuidelines: [
			"When PI plan mode is active, call submit_plan exactly once as the sole final tool call instead of printing a Markdown plan.",
			"Keep submit_plan step titles concise; put paths, rationale, constraints, and verification notes in optional details.",
		],
		parameters: submitPlanSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!planModeEnabled) throw new Error("submit_plan is only available while plan mode is active.");

			items = params.steps.map((step, index) => {
				const details = step.details ? cleanSubmittedText(step.details, 800) : undefined;
				return {
					step: index + 1,
					text: cleanSubmittedText(step.title, 120),
					...(details ? { details } : {}),
					completed: false,
				};
			});
			planSubmittedForRun = true;
			persistState();

			const interactive = ctx.mode === "tui" || ctx.mode === "rpc";
			const plainPlan = items.map(formatPromptItem).join("\n");
			const content = interactive
				? `Submitted ${items.length} plan step(s) for user approval.`
				: `No interactive approval UI is available. Present this submitted plan to the user now:\n\nPlan:\n${plainPlan}`;
			return {
				content: [{ type: "text", text: content }],
				details: { items: cloneItems() } satisfies SubmitPlanDetails,
				terminate: interactive ? true : undefined,
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("Plan")), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as SubmitPlanDetails | undefined;
			if (!details?.items) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			const lines = details.items.map((item) => {
				let line = `${theme.fg("accent", `${item.step}.`)} ${formatPlanItem(item, 100)}`;
				if (expanded && item.details) line += `\n   ${theme.fg("muted", item.details)}`;
				return line;
			});
			if (!expanded && details.items.some((item) => item.details)) {
				lines.push(theme.fg("dim", "Expand to show implementation details."));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

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
				planSubmittedForRun = false;
				if (!planModeEnabled) {
					restoreTools();
					previousActiveTools = undefined;
				}
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

	pi.on("before_agent_start", async (_event, ctx) => {
		const customType = planModeEnabled
			? PLANNING_CONTEXT_TYPE
			: executionMode && items.length > 0
				? EXECUTION_CONTEXT_TYPE
				: NORMAL_CONTEXT_TYPE;
		const content = planModeEnabled
			? planningContext(ctx.mode === "tui" || ctx.mode === "rpc")
			: executionMode && items.length > 0
				? executionContext(items)
				: normalContext();
		return { message: { customType, content, display: false } };
	});

	pi.on("context", async (event) => {
		const compatibleTypes = planModeEnabled
			? new Set([PLANNING_CONTEXT_TYPE])
			: executionMode && items.length > 0
				? new Set([EXECUTION_CONTEXT_TYPE, EXECUTE_TYPE])
				: new Set([NORMAL_CONTEXT_TYPE]);

		let latestCompatibleIndex = -1;
		for (let index = 0; index < event.messages.length; index++) {
			const customType = customTypeOf(event.messages[index]);
			if (customType && compatibleTypes.has(customType)) latestCompatibleIndex = index;
		}

		return {
			messages: event.messages.filter((message, index) => {
				const customType = customTypeOf(message);
				if (!customType || !MANAGED_CONTEXT_TYPES.has(customType)) return true;
				return index === latestCompatibleIndex;
			}),
		};
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
			planSubmittedForRun = false;
			if (items.every((item) => item.completed)) {
				const completedItems = cloneItems();
				executionMode = false;
				items = [];
				executionId = undefined;
				previousActiveTools = undefined;
				updateStatus(ctx);
				persistState();
				pi.appendEntry<PlanCardData>(PLAN_CARD_TYPE, {
					title: "Plan complete",
					items: completedItems,
					completed: true,
				});
			}
			return;
		}

		if (!planModeEnabled) {
			planSubmittedForRun = false;
			return;
		}

		const submitted = planSubmittedForRun;
		planSubmittedForRun = false;
		if (!submitted) {
			const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
			if (!lastAssistant) return;
			const extracted = extractPlanItems(textFromAssistant(lastAssistant));
			if (extracted.length === 0) return;
			items = extracted;
			persistState();
			pi.appendEntry<PlanCardData>(PLAN_CARD_TYPE, { title: "Plan", items: cloneItems() });
		}

		if (items.length === 0 || !ctx.hasUI) return;

		const choice = await ctx.ui.select("Plan ready", [
			"Execute plan",
			"Refine plan",
			"Stay in plan mode",
			"Disable plan mode",
		]);
		if (choice === "Execute plan") return startExecution(ctx);
		if (choice === "Disable plan mode") return disablePlanMode(ctx);
		if (choice === "Refine plan") {
			const refinement = await ctx.ui.editor("Refine plan:", "");
			if (refinement?.trim()) pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
		}
		updateStatus(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		structuredPlanEnabled = ctx.mode === "tui" || ctx.mode === "rpc";
		normalToolFallback = withoutInternalTools(pi.getActiveTools());
		const branch = ctx.sessionManager.getBranch() as BranchEntry[];
		const latestState = [...branch]
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === STATE_TYPE)?.data as StoredState | undefined;

		if (latestState) {
			planModeEnabled = latestState.planModeEnabled ?? false;
			executionMode = latestState.executionMode ?? false;
			items = (latestState.items ?? []).map((item) => ({ ...item }));
			previousActiveTools = latestState.previousActiveTools
				? withoutInternalTools(latestState.previousActiveTools)
				: undefined;
			executionId = latestState.executionId;
			if (previousActiveTools?.length) normalToolFallback = [...previousActiveTools];
		}

		if (pi.getFlag("plan") === true) {
			if (!previousActiveTools?.length) previousActiveTools = [...normalToolFallback];
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

		if (planModeEnabled) activatePlanTools();
		else if (executionMode) restoreTools();
		else {
			const normalTools = withoutInternalTools(pi.getActiveTools());
			pi.setActiveTools(normalTools);
			normalToolFallback = normalTools;
		}
		updateStatus(ctx);
	});
}
