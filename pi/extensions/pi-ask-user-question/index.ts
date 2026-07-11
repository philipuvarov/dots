import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TYPE_SOMETHING = "Type something.";
const NEXT_LABEL = "Next →";
const SUBMIT_LABEL = "Submit";
const CANCEL_LABEL = "Cancel";
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;
const MAX_PREVIEW_LINES = 14;

const RESERVED_LABELS = new Set(
	["Other", TYPE_SOMETHING, "Chat about this", NEXT_LABEL, SUBMIT_LABEL, CANCEL_LABEL].map((label) =>
		normalizeLabel(label),
	),
);

const OptionSchema = Type.Object({
	label: Type.String({
		description: "Short option label, 1-5 words. Must not use reserved runtime labels.",
		minLength: 1,
		maxLength: 60,
	}),
	description: Type.Optional(
		Type.String({ description: "Optional explanation or trade-off for this option.", maxLength: 240 }),
	),
	preview: Type.Optional(
		Type.String({ description: "Optional code, markdown, ASCII diagram, or short preview for this option." }),
	),
});

const QuestionSchema = Type.Object({
	question: Type.String({ description: "Full clarifying question for the user.", minLength: 1, maxLength: 300 }),
	header: Type.Optional(
		Type.String({ description: "Short tab label for this question. Defaults to Q1, Q2, etc.", maxLength: 16 }),
	),
	options: Type.Array(OptionSchema, {
		description: "Candidate answers. Provide 2-6 clear options.",
		minItems: 2,
		maxItems: MAX_OPTIONS,
	}),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple options. Defaults to false.", default: false })),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Offer a free-text fallback option. Defaults to true.", default: true }),
	),
});

const AskUserQuestionParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "Questions to ask in one dialog. Keep this small and focused.",
		minItems: 1,
		maxItems: MAX_QUESTIONS,
	}),
});

interface RawOption {
	label: string;
	description?: string;
	preview?: string;
}

interface RawQuestion {
	question: string;
	header?: string;
	options: RawOption[];
	multiSelect?: boolean;
	allowOther?: boolean;
}

interface NormalizedOption {
	label: string;
	description?: string;
	preview?: string;
}

interface NormalizedQuestion {
	question: string;
	header: string;
	options: NormalizedOption[];
	multiSelect: boolean;
	allowOther: boolean;
}

type AskErrorCode =
	| "no_ui"
	| "no_questions"
	| "too_many_questions"
	| "empty_options"
	| "too_many_options"
	| "duplicate_question"
	| "duplicate_option_label"
	| "reserved_label";

interface AskAnswerDetails {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
	optionNotes?: Record<string, string>;
	preview?: string;
	previews?: Record<string, string>;
}

interface AskUserQuestionDetails {
	answers: AskAnswerDetails[];
	cancelled: boolean;
	error?: AskErrorCode;
}

type SingleAnswer = { kind: "option"; optionIndex: number } | { kind: "custom"; text: string };
type DialogRow =
	| { type: "option"; optionIndex: number; option: NormalizedOption }
	| { type: "other" }
	| { type: "next" };

function normalizeLabel(label: string): string {
	return label.trim().toLocaleLowerCase();
}

function compactText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function normalizeQuestions(rawQuestions: RawQuestion[]):
	| { ok: true; questions: NormalizedQuestion[] }
	| { ok: false; error: AskErrorCode; message: string } {
	if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
		return { ok: false, error: "no_questions", message: "ask_user_question needs at least one question." };
	}
	if (rawQuestions.length > MAX_QUESTIONS) {
		return {
			ok: false,
			error: "too_many_questions",
			message: `ask_user_question supports at most ${MAX_QUESTIONS} questions per call.`,
		};
	}

	const seenQuestions = new Set<string>();
	const questions: NormalizedQuestion[] = [];

	for (let qi = 0; qi < rawQuestions.length; qi++) {
		const raw = rawQuestions[qi];
		const question = raw.question.trim();
		const questionKey = normalizeLabel(question);
		if (seenQuestions.has(questionKey)) {
			return { ok: false, error: "duplicate_question", message: `Duplicate question at index ${qi + 1}.` };
		}
		seenQuestions.add(questionKey);

		if (!Array.isArray(raw.options) || raw.options.length < 2) {
			return { ok: false, error: "empty_options", message: `Question ${qi + 1} needs at least two options.` };
		}
		if (raw.options.length > MAX_OPTIONS) {
			return {
				ok: false,
				error: "too_many_options",
				message: `Question ${qi + 1} has too many options; maximum is ${MAX_OPTIONS}.`,
			};
		}

		const seenOptions = new Set<string>();
		const options: NormalizedOption[] = [];
		for (let oi = 0; oi < raw.options.length; oi++) {
			const option = raw.options[oi];
			const label = option.label.trim();
			const key = normalizeLabel(label);
			if (RESERVED_LABELS.has(key)) {
				return {
					ok: false,
					error: "reserved_label",
					message: `Question ${qi + 1}, option ${oi + 1} uses reserved label: ${label}`,
				};
			}
			if (seenOptions.has(key)) {
				return {
					ok: false,
					error: "duplicate_option_label",
					message: `Question ${qi + 1} has duplicate option label: ${label}`,
				};
			}
			seenOptions.add(key);
			options.push({
				label,
				description: compactText(option.description),
				preview: compactText(option.preview),
			});
		}

		const header = compactText(raw.header)?.slice(0, 16) || `Q${qi + 1}`;
		questions.push({
			question,
			header,
			options,
			multiSelect: raw.multiSelect === true,
			allowOther: raw.allowOther !== false,
		});
	}

	return { ok: true, questions };
}

function errorResult(message: string, error: AskErrorCode): AgentToolResult<AskUserQuestionDetails> {
	return {
		content: [{ type: "text", text: message }],
		details: { answers: [], cancelled: true, error },
	};
}

function formatContent(details: AskUserQuestionDetails): string {
	if (details.error) {
		return `ask_user_question failed: ${details.error}`;
	}
	if (details.cancelled) {
		return "User cancelled ask_user_question.";
	}
	if (details.answers.length === 0) {
		return "No answers returned.";
	}

	const lines = ["User answered ask_user_question:"];
	for (const answer of details.answers) {
		const value = answer.kind === "multi" ? (answer.selected?.join(", ") || "(none)") : (answer.answer ?? "(none)");
		lines.push(`${answer.questionIndex}. ${answer.question}`);
		lines.push(`   Answer: ${value}`);
		if (answer.notes) {
			lines.push("   Notes:");
			for (const noteLine of answer.notes.split(/\r?\n/)) {
				lines.push(`   - ${noteLine}`);
			}
		}
	}
	return lines.join("\n");
}

function wrapPlain(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const out: string[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		if (rawLine.length === 0) {
			out.push("");
			continue;
		}
		const wrapped = wrapTextWithAnsi(rawLine, safeWidth);
		out.push(...(wrapped.length > 0 ? wrapped : [truncateToWidth(rawLine, safeWidth)]));
	}
	return out.length > 0 ? out : [""];
}

function padToWidth(text: string, width: number): string {
	const padding = Math.max(0, width - visibleWidth(text));
	return text + " ".repeat(padding);
}

function noteKey(questionIndex: number, optionIndex: number | "custom"): string {
	return `${questionIndex}:${optionIndex}`;
}

function combineNotes(optionNotes: Record<string, string>): string | undefined {
	const lines = Object.entries(optionNotes).map(([label, note]) => `${label}: ${note}`);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function makeMissingAnswer(question: NormalizedQuestion, questionIndex: number): AskAnswerDetails {
	return {
		questionIndex: questionIndex + 1,
		question: question.question,
		kind: question.multiSelect ? "multi" : "option",
		answer: null,
		selected: question.multiSelect ? [] : undefined,
	};
}

async function askWithSimpleUi(
	questions: NormalizedQuestion[],
	ctx: ExtensionContext,
): Promise<AgentToolResult<AskUserQuestionDetails>> {
	const answers: AskAnswerDetails[] = [];

	for (let qi = 0; qi < questions.length; qi++) {
		const question = questions[qi];

		if (question.multiSelect) {
			const prompt = [
				question.question,
				"",
				...question.options.map((option, index) => {
					const description = option.description ? ` — ${option.description}` : "";
					return `${index + 1}. ${option.label}${description}`;
				}),
				"",
				question.allowOther
					? "Enter comma-separated option numbers, or include custom text."
					: "Enter comma-separated option numbers.",
			].join("\n");
			const raw = await ctx.ui.input(prompt, "1,3");
			if (raw === undefined) {
				const details = { answers, cancelled: true } satisfies AskUserQuestionDetails;
				return { content: [{ type: "text", text: formatContent(details) }], details };
			}

			const selected: string[] = [];
			const previews: Record<string, string> = {};
			for (const piece of raw
				.split(",")
				.map((part) => part.trim())
				.filter(Boolean)) {
				const number = Number.parseInt(piece, 10);
				if (Number.isInteger(number) && number >= 1 && number <= question.options.length) {
					const option = question.options[number - 1];
					if (!selected.includes(option.label)) selected.push(option.label);
					if (option.preview) previews[option.label] = option.preview;
				} else if (question.allowOther && !selected.includes(piece)) {
					selected.push(piece);
				}
			}

			answers.push({
				questionIndex: qi + 1,
				question: question.question,
				kind: "multi",
				answer: selected.length > 0 ? selected.join(", ") : null,
				selected,
				previews: Object.keys(previews).length > 0 ? previews : undefined,
			});
			continue;
		}

		const choices = question.allowOther ? [...question.options.map((option) => option.label), TYPE_SOMETHING] : question.options.map((option) => option.label);
		const choice = await ctx.ui.select(question.question, choices);
		if (!choice) {
			const details = { answers, cancelled: true } satisfies AskUserQuestionDetails;
			return { content: [{ type: "text", text: formatContent(details) }], details };
		}
		if (choice === TYPE_SOMETHING) {
			const custom = await ctx.ui.input(question.question, "Your answer");
			if (custom === undefined) {
				const details = { answers, cancelled: true } satisfies AskUserQuestionDetails;
				return { content: [{ type: "text", text: formatContent(details) }], details };
			}
			answers.push({
				questionIndex: qi + 1,
				question: question.question,
				kind: "custom",
				answer: custom.trim() || null,
			});
			continue;
		}

		const option = question.options.find((item) => item.label === choice);
		answers.push({
			questionIndex: qi + 1,
			question: question.question,
			kind: "option",
			answer: choice,
			preview: option?.preview,
		});
	}

	const details = { answers, cancelled: false } satisfies AskUserQuestionDetails;
	return { content: [{ type: "text", text: formatContent(details) }], details };
}

async function askWithTui(questions: NormalizedQuestion[], ctx: ExtensionContext): Promise<AskUserQuestionDetails> {
	const result = await ctx.ui.custom<AskUserQuestionDetails>((tui, theme, _keybindings, done) => {
		let currentTab = 0;
		let selectedIndex = 0;
		let mode: "select" | "custom" | "note" = "select";
		let editingQuestionIndex = 0;
		let editingNoteKey: string | undefined;
		let editingTitle = "";
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;

		const singleAnswers = new Map<number, SingleAnswer>();
		const multiSelections = new Map<number, Set<number>>();
		const customAnswers = new Map<number, string>();
		const notes = new Map<string, string>();

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function invalidateCache() {
			cachedWidth = undefined;
			cachedLines = undefined;
		}

		function refresh() {
			invalidateCache();
			tui.requestRender();
		}

		function rowsFor(questionIndex: number): DialogRow[] {
			const question = questions[questionIndex];
			const rows: DialogRow[] = question.options.map((option, optionIndex) => ({ type: "option", optionIndex, option }));
			if (question.allowOther) rows.push({ type: "other" });
			if (question.multiSelect) rows.push({ type: "next" });
			return rows;
		}

		function selectedSet(questionIndex: number): Set<number> {
			let set = multiSelections.get(questionIndex);
			if (!set) {
				set = new Set<number>();
				multiSelections.set(questionIndex, set);
			}
			return set;
		}

		function isAnswered(questionIndex: number): boolean {
			const question = questions[questionIndex];
			if (question.multiSelect) {
				return selectedSet(questionIndex).size > 0 || customAnswers.has(questionIndex);
			}
			return singleAnswers.has(questionIndex);
		}

		function allAnswered(): boolean {
			return questions.every((_question, index) => isAnswered(index));
		}

		function clampSelection() {
			if (currentTab >= questions.length) {
				selectedIndex = 0;
				return;
			}
			const rowCount = rowsFor(currentTab).length;
			selectedIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, rowCount - 1));
		}

		function moveTab(delta: number) {
			mode = "select";
			editor.setText("");
			currentTab = (currentTab + delta + questions.length + 1) % (questions.length + 1);
			selectedIndex = 0;
			clampSelection();
			refresh();
		}

		function advanceAfterAnswer() {
			if (currentTab < questions.length - 1) {
				currentTab++;
			} else {
				currentTab = questions.length;
			}
			selectedIndex = 0;
			clampSelection();
			refresh();
		}

		function currentRow(): DialogRow | undefined {
			if (currentTab >= questions.length) return undefined;
			return rowsFor(currentTab)[selectedIndex];
		}

		function noteTargetForCurrentRow(): { key: string; label: string } | undefined {
			const row = currentRow();
			if (!row) return undefined;
			if (row.type === "option") {
				return { key: noteKey(currentTab, row.optionIndex), label: row.option.label };
			}
			if (row.type === "other" && customAnswers.has(currentTab)) {
				return { key: noteKey(currentTab, "custom"), label: customAnswers.get(currentTab)! };
			}
			return undefined;
		}

		function startCustomInput() {
			editingQuestionIndex = currentTab;
			mode = "custom";
			editingTitle = questions[currentTab].multiSelect ? "Custom option" : "Custom answer";
			editor.setText(customAnswers.get(currentTab) ?? "");
			refresh();
		}

		function startNoteInput() {
			const target = noteTargetForCurrentRow();
			if (!target) return;
			editingQuestionIndex = currentTab;
			editingNoteKey = target.key;
			editingTitle = `Note for ${target.label}`;
			mode = "note";
			editor.setText(notes.get(target.key) ?? "");
			refresh();
		}

		function buildDetails(cancelled: boolean): AskUserQuestionDetails {
			const answers: AskAnswerDetails[] = questions.map((question, qi) => {
				if (question.multiSelect) {
					const selected = [...selectedSet(qi)].sort((a, b) => a - b);
					const labels: string[] = [];
					const previews: Record<string, string> = {};
					const optionNotes: Record<string, string> = {};

					for (const optionIndex of selected) {
						const option = question.options[optionIndex];
						labels.push(option.label);
						if (option.preview) previews[option.label] = option.preview;
						const note = notes.get(noteKey(qi, optionIndex));
						if (note) optionNotes[option.label] = note;
					}

					const custom = customAnswers.get(qi);
					if (custom) {
						labels.push(custom);
						const note = notes.get(noteKey(qi, "custom"));
						if (note) optionNotes[custom] = note;
					}

					return {
						questionIndex: qi + 1,
						question: question.question,
						kind: "multi",
						answer: labels.length > 0 ? labels.join(", ") : null,
						selected: labels,
						notes: combineNotes(optionNotes),
						optionNotes: Object.keys(optionNotes).length > 0 ? optionNotes : undefined,
						previews: Object.keys(previews).length > 0 ? previews : undefined,
					};
				}

				const answer = singleAnswers.get(qi);
				if (!answer) return makeMissingAnswer(question, qi);

				if (answer.kind === "custom") {
					const note = notes.get(noteKey(qi, "custom"));
					return {
						questionIndex: qi + 1,
						question: question.question,
						kind: "custom",
						answer: answer.text,
						notes: note,
						optionNotes: note ? { [answer.text]: note } : undefined,
					};
				}

				const option = question.options[answer.optionIndex];
				const note = notes.get(noteKey(qi, answer.optionIndex));
				return {
					questionIndex: qi + 1,
					question: question.question,
					kind: "option",
					answer: option.label,
					notes: note,
					optionNotes: note ? { [option.label]: note } : undefined,
					preview: option.preview,
				};
			});

			return { answers, cancelled };
		}

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (mode === "custom") {
				const question = questions[editingQuestionIndex];
				if (trimmed) {
					customAnswers.set(editingQuestionIndex, trimmed);
					if (!question.multiSelect) {
						singleAnswers.set(editingQuestionIndex, { kind: "custom", text: trimmed });
					}
				} else if (question.multiSelect) {
					customAnswers.delete(editingQuestionIndex);
					notes.delete(noteKey(editingQuestionIndex, "custom"));
				}

				mode = "select";
				editor.setText("");
				if (trimmed && !question.multiSelect) {
					advanceAfterAnswer();
				} else {
					refresh();
				}
				return;
			}

			if (mode === "note" && editingNoteKey) {
				if (trimmed) notes.set(editingNoteKey, trimmed);
				else notes.delete(editingNoteKey);
				editingNoteKey = undefined;
				mode = "select";
				editor.setText("");
				refresh();
			}
		};

		function activateCurrentRow() {
			const question = questions[currentTab];
			const row = currentRow();
			if (!row) return;

			if (row.type === "next") {
				advanceAfterAnswer();
				return;
			}

			if (row.type === "other") {
				startCustomInput();
				return;
			}

			if (question.multiSelect) {
				const set = selectedSet(currentTab);
				if (set.has(row.optionIndex)) set.delete(row.optionIndex);
				else set.add(row.optionIndex);
				refresh();
				return;
			}

			singleAnswers.set(currentTab, { kind: "option", optionIndex: row.optionIndex });
			advanceAfterAnswer();
		}

		function handleInput(data: string) {
			if (mode !== "select") {
				if (matchesKey(data, Key.escape)) {
					mode = "select";
					editingNoteKey = undefined;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				moveTab(1);
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				moveTab(-1);
				return;
			}

			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) {
					done(buildDetails(false));
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done(buildDetails(true));
				}
				return;
			}

			const rows = rowsFor(currentTab);
			if (matchesKey(data, Key.up)) {
				selectedIndex = Math.max(0, selectedIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
				refresh();
				return;
			}
			if (data === "n" || data === "N") {
				startNoteInput();
				return;
			}
			if (matchesKey(data, Key.enter) || (questions[currentTab].multiSelect && matchesKey(data, Key.space))) {
				activateCurrentRow();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(buildDetails(true));
			}
		}

		function renderTabs(width: number): string {
			const tabs = questions.map((question, index) => {
				const answered = isAnswered(index);
				const label = `${answered ? "■" : "□"} ${question.header}`;
				if (index === currentTab) return theme.bg("selectedBg", theme.fg("text", ` ${label} `));
				return theme.fg(answered ? "success" : "muted", ` ${label} `);
			});
			const submit = currentTab === questions.length
				? theme.bg("selectedBg", theme.fg("text", ` ✓ ${SUBMIT_LABEL} `))
				: theme.fg(allAnswered() ? "success" : "dim", ` ✓ ${SUBMIT_LABEL} `);
			return truncateToWidth(` ${tabs.join(" ")} ${submit}`, width);
		}

		function optionLines(width: number): string[] {
			const question = questions[currentTab];
			const rows = rowsFor(currentTab);
			const lines: string[] = [];
			const single = singleAnswers.get(currentTab);
			const multi = selectedSet(currentTab);

			for (let index = 0; index < rows.length; index++) {
				const row = rows[index];
				const selected = index === selectedIndex;
				const prefix = selected ? theme.fg("accent", "> ") : "  ";

				if (row.type === "next") {
					const label = isAnswered(currentTab) ? NEXT_LABEL : `${NEXT_LABEL} ${theme.fg("warning", "(unanswered ok)")}`;
					lines.push(truncateToWidth(prefix + (selected ? theme.fg("accent", label) : theme.fg("muted", label)), width));
					continue;
				}

				if (row.type === "other") {
					const custom = customAnswers.get(currentTab);
					const checked = question.multiSelect ? (custom ? "[x] " : "[ ] ") : single?.kind === "custom" ? "✓ " : "";
					const label = custom ? `${TYPE_SOMETHING} ${theme.fg("muted", custom)}` : TYPE_SOMETHING;
					const note = custom && notes.has(noteKey(currentTab, "custom")) ? theme.fg("muted", " [note]") : "";
					lines.push(truncateToWidth(prefix + theme.fg(selected ? "accent" : "text", `${checked}${label}`) + note, width));
					continue;
				}

				const checked = question.multiSelect
					? multi.has(row.optionIndex)
						? "[x] "
						: "[ ] "
					: single?.kind === "option" && single.optionIndex === row.optionIndex
						? "✓ "
						: "";
				const note = notes.has(noteKey(currentTab, row.optionIndex)) ? theme.fg("muted", " [note]") : "";
				const title = `${checked}${index + 1}. ${row.option.label}`;
				lines.push(truncateToWidth(prefix + theme.fg(selected ? "accent" : "text", title) + note, width));
				if (row.option.description) {
					for (const descLine of wrapPlain(row.option.description, Math.max(1, width - 5))) {
						lines.push(truncateToWidth(`     ${theme.fg("muted", descLine)}`, width));
					}
				}
			}

			return lines;
		}

		function currentPreview(): { title: string; text: string } | undefined {
			const row = currentRow();
			if (!row) return undefined;
			if (row.type === "option" && row.option.preview) return { title: row.option.label, text: row.option.preview };
			if (row.type === "other" && customAnswers.has(currentTab)) {
				return { title: "Custom answer", text: customAnswers.get(currentTab)! };
			}
			return undefined;
		}

		function previewLines(width: number): string[] {
			const preview = currentPreview();
			if (!preview) return [theme.fg("dim", "No preview for highlighted option.")];

			const lines = [theme.fg("muted", `Preview: ${preview.title}`)];
			const body = wrapPlain(preview.text, width).slice(0, MAX_PREVIEW_LINES);
			for (const line of body) lines.push(theme.fg("dim", line));
			if (wrapPlain(preview.text, width).length > MAX_PREVIEW_LINES) {
				lines.push(theme.fg("dim", "… preview truncated"));
			}
			return lines.map((line) => truncateToWidth(line, width));
		}

		function answerSummary(questionIndex: number): string {
			const question = questions[questionIndex];
			if (question.multiSelect) {
				const labels = [...selectedSet(questionIndex)]
					.sort((a, b) => a - b)
					.map((optionIndex) => question.options[optionIndex].label);
				const custom = customAnswers.get(questionIndex);
				if (custom) labels.push(custom);
				return labels.length > 0 ? labels.join(", ") : "(unanswered)";
			}

			const answer = singleAnswers.get(questionIndex);
			if (!answer) return "(unanswered)";
			if (answer.kind === "custom") return answer.text;
			return question.options[answer.optionIndex].label;
		}

		function addWrappedWithPrefix(
			width: number,
			add: (line: string) => void,
			prefix: string,
			text: string,
			format: (line: string) => string,
		) {
			const prefixWidth = visibleWidth(prefix);
			const wrapped = wrapPlain(text, Math.max(1, width - prefixWidth));
			const continuationPrefix = " ".repeat(prefixWidth);
			for (let index = 0; index < wrapped.length; index++) {
				add(`${index === 0 ? prefix : continuationPrefix}${format(wrapped[index] ?? "")}`);
			}
		}

		function renderQuestionBody(width: number, add: (line: string) => void) {
			const question = questions[currentTab];
			addWrappedWithPrefix(width, add, " ", question.question, (line) => theme.fg("text", line));
			if (question.multiSelect) {
				addWrappedWithPrefix(width, add, " ", "Multi-select: Space/Enter toggles options, then choose Next.", (line) =>
					theme.fg("dim", line),
				);
			}
			add("");

			const preview = currentPreview();
			if (preview && width >= 96) {
				const leftWidth = Math.max(36, Math.floor((width - 3) * 0.52));
				const rightWidth = Math.max(20, width - leftWidth - 3);
				const left = optionLines(leftWidth);
				const right = previewLines(rightWidth);
				const max = Math.max(left.length, right.length);
				for (let i = 0; i < max; i++) {
					const leftLine = padToWidth(left[i] ?? "", leftWidth);
					const rightLine = right[i] ?? "";
					add(`${leftLine} ${theme.fg("dim", "│")} ${rightLine}`);
				}
			} else {
				for (const line of optionLines(width)) add(line);
				if (preview) {
					add("");
					for (const line of previewLines(width)) add(line);
				}
			}
		}

		function renderSubmit(width: number, add: (line: string) => void) {
			add(theme.fg("accent", theme.bold(" Review answers")));
			add("");
			for (let qi = 0; qi < questions.length; qi++) {
				const answered = isAnswered(qi);
				const q = questions[qi];
				addWrappedWithPrefix(width, add, ` ${qi + 1}. `, q.question, (line) =>
					theme.fg(answered ? "text" : "warning", line),
				);
				for (const line of wrapPlain(answerSummary(qi), Math.max(1, width - 5))) {
					add(`     ${theme.fg(answered ? "success" : "warning", line)}`);
				}
			}
			add("");
			if (allAnswered()) {
				add(theme.fg("success", " Enter to submit answers."));
			} else {
				const missing = questions
					.map((question, index) => ({ question, index }))
					.filter(({ index }) => !isAnswered(index))
					.map(({ question }) => question.header)
					.join(", ");
				add(theme.fg("warning", ` Missing answers: ${missing}`));
			}
		}

		function renderEditorMode(width: number, add: (line: string) => void) {
			const question = questions[editingQuestionIndex];
			addWrappedWithPrefix(width, add, " ", question.question, (line) => theme.fg("text", line));
			add("");
			add(theme.fg("accent", ` ${editingTitle}:`));
			for (const line of editor.render(Math.max(1, width - 2))) {
				add(` ${line}`);
			}
			add("");
			add(theme.fg("dim", " Enter to save • Esc to go back"));
		}

		function render(widthArg: number): string[] {
			const width = Math.max(20, widthArg);
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (line: string) => lines.push(truncateToWidth(line, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("toolTitle", theme.bold(" ask_user_question")) + theme.fg("dim", " — answer needed to continue"));
			add(renderTabs(width));
			add("");

			if (mode !== "select") {
				renderEditorMode(width, add);
			} else if (currentTab === questions.length) {
				renderSubmit(width, add);
			} else {
				renderQuestionBody(width, add);
			}

			add("");
			if (mode === "select") {
				const hint = currentTab === questions.length
					? " Tab/←→ review questions • Enter submit • Esc cancel"
					: " Tab/←→ tabs • ↑↓ move • Enter choose/toggle • n note • Esc cancel";
				add(theme.fg("dim", hint));
			}
			add(theme.fg("accent", "─".repeat(width)));

			cachedWidth = width;
			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: invalidateCache,
			handleInput,
		};
	});

	return result ?? { answers: questions.map(makeMissingAnswer), cancelled: true };
}

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description:
			"Ask the user one or more structured clarifying questions. Supports single-select, multi-select, option previews, notes, and a free-text fallback.",
		promptSnippet: "Ask the user structured clarifying questions when needed to avoid guessing.",
		promptGuidelines: [
			"Use ask_user_question when required information is missing, requirements are ambiguous, or user preference changes implementation.",
			`Ask at most ${MAX_QUESTIONS} focused questions per ask_user_question call, each with 2-${MAX_OPTIONS} concise options.`,
			"Do not use ask_user_question when you can infer safely from repository context or existing user instructions.",
			"For ask_user_question options, include clear labels and descriptions; include preview text when comparing code, layouts, APIs, or plans.",
			"After ask_user_question returns, continue using the user's selected answers and notes.",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const normalized = normalizeQuestions(params.questions as RawQuestion[]);
			if (!normalized.ok) return errorResult(normalized.message, normalized.error);

			if (signal?.aborted) {
				const details = { answers: normalized.questions.map(makeMissingAnswer), cancelled: true } satisfies AskUserQuestionDetails;
				return { content: [{ type: "text", text: formatContent(details) }], details };
			}

			if (ctx.mode === "tui") {
				const details = await askWithTui(normalized.questions, ctx);
				return { content: [{ type: "text", text: formatContent(details) }], details };
			}

			if (ctx.hasUI) {
				return askWithSimpleUi(normalized.questions, ctx);
			}

			return errorResult("ask_user_question unavailable: pi is running without interactive UI.", "no_ui");
		},

		renderCall(args, theme, _context) {
			const rawQuestions = Array.isArray(args.questions) ? (args.questions as RawQuestion[]) : [];
			const count = rawQuestions.length;
			const labels = rawQuestions
				.map((question, index) => compactText(question.header) || `Q${index + 1}`)
				.join(", ");
			let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
			text += theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`);
			if (labels) text += theme.fg("dim", ` (${truncateToWidth(labels, 48)})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskUserQuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.error) {
				return new Text(theme.fg("error", `ask_user_question failed: ${details.error}`), 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const lines = details.answers.map((answer) => {
				const value = answer.kind === "multi" ? (answer.selected?.join(", ") || "(none)") : (answer.answer ?? "(none)");
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", `Q${answer.questionIndex}`)} ${theme.fg("text", value)}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
