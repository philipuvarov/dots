export interface PlanItem {
	step: number;
	text: string;
	details?: string;
	completed: boolean;
}

const SAFE_PATTERNS = [
	/^cat\b/i,
	/^head\b/i,
	/^tail\b/i,
	/^less\b/i,
	/^more\b/i,
	/^grep\b/i,
	/^ls\b/i,
	/^pwd\b/i,
	/^cd\b/i,
	/^echo\b/i,
	/^printf\b/i,
	/^wc\b/i,
	/^file\b/i,
	/^stat\b/i,
	/^du\b/i,
	/^df\b/i,
	/^tree\b/i,
	/^which\b/i,
	/^whereis\b/i,
	/^type\b/i,
	/^printenv\b/i,
	/^uname\b/i,
	/^whoami\b/i,
	/^id\b/i,
	/^date\b/i,
	/^cal\b/i,
	/^uptime\b/i,
	/^ps\b/i,
	/^top\b/i,
	/^htop\b/i,
	/^free\b/i,
	/^jq\b/i,
	/^rg\b/i,
	/^fd\b/i,
	/^bat\b/i,
	/^eza\b/i,
];

const SEGMENT_SEPARATORS = new Set([";", "&", "|", "\n", "(", ")", "`"]);

function splitCommandSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	const flush = () => {
		const trimmed = current.trim();
		if (trimmed.length > 0) segments.push(trimmed);
		current = "";
	};

	for (const ch of command) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			current += ch;
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (SEGMENT_SEPARATORS.has(ch)) {
			flush();
			continue;
		}
		current += ch;
	}
	flush();
	return segments;
}

function shellWords(command: string): string[] | undefined {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	const flush = () => {
		if (current.length > 0) words.push(current);
		current = "";
	};

	for (const ch of command.trim()) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		current += ch;
	}

	if (quote || escaped) return undefined;
	flush();
	return words;
}

function hasUnsafeWriteRedirection(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (let index = 0; index < command.length; index++) {
		const ch = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch !== ">") continue;

		let targetStart = index + 1;
		if (command[targetStart] === ">") targetStart++;
		while (/\s/.test(command[targetStart] ?? "")) targetStart++;
		const target = command.slice(targetStart).match(/^[^\s;&|()]+/)?.[0];
		if (target === "/dev/null") {
			index = targetStart + target.length - 1;
			continue;
		}
		return true;
	}
	return false;
}

function isSafeGitCommand(words: string[]): boolean {
	let index = 1;
	while (index < words.length) {
		const word = words[index];
		if (word === "-C" || word === "--git-dir" || word === "--work-tree" || word === "-c") {
			index += 2;
			continue;
		}
		if (/^--(?:git-dir|work-tree)=/.test(word)) {
			index++;
			continue;
		}
		if (["--no-pager", "--paginate", "--no-optional-locks", "--literal-pathspecs"].includes(word)) {
			index++;
			continue;
		}
		break;
	}

	const subcommand = words[index]?.toLowerCase();
	if (!subcommand) return false;
	const args = words.slice(index + 1);
	if (args.some((arg) => ["--ext-diff", "--textconv"].includes(arg) || arg === "--output" || arg.startsWith("--output="))) {
		return false;
	}

	if (
		[
			"status",
			"log",
			"diff",
			"show",
			"ls-files",
			"ls-tree",
			"grep",
			"rev-parse",
			"describe",
			"name-rev",
			"shortlog",
			"blame",
		].includes(subcommand)
	) {
		return true;
	}

	if (subcommand === "branch") {
		if (args.length === 0) return true;
		const mutationFlags = new Set([
			"-d",
			"-D",
			"-m",
			"-M",
			"-c",
			"-C",
			"--delete",
			"--move",
			"--copy",
			"--edit-description",
			"--set-upstream-to",
			"--unset-upstream",
		]);
		if (args.some((arg) => mutationFlags.has(arg) || /^-[dDmMcC].+/.test(arg))) return false;
		if (args.includes("--list")) return true;
		return args.every((arg) => arg.startsWith("-"));
	}

	if (subcommand === "remote") {
		if (args.length === 0 || args.every((arg) => arg === "-v" || arg === "--verbose")) return true;
		return args[0] === "get-url" || args[0] === "show";
	}

	if (subcommand === "config") {
		if (args.some((arg) => ["--add", "--unset", "--unset-all", "--rename-section", "--remove-section"].includes(arg))) {
			return false;
		}
		return args.some((arg) =>
			["--get", "--get-all", "--get-regexp", "--list", "-l", "--get-urlmatch"].includes(arg),
		);
	}

	if (subcommand === "worktree") return args[0] === "list";
	return false;
}

function hasOption(words: string[], ...options: string[]): boolean {
	return words.some((word) =>
		options.some(
			(option) =>
				word === option ||
				word.startsWith(`${option}=`) ||
				(option.startsWith("-") && !option.startsWith("--") && word.startsWith(option) && word.length > option.length),
		),
	);
}

function isSafeCurlCommand(words: string[]): boolean {
	if (hasOption(words, "-o", "--output", "-O", "--remote-name", "-T", "--upload-file")) {
		const outputIndex = words.findIndex((word) => word === "-o" || word === "--output");
		const outputTarget = outputIndex >= 0 ? words[outputIndex + 1] : undefined;
		const onlyDevNullOutput = outputTarget === "/dev/null" && !hasOption(words, "-O", "--remote-name", "-T", "--upload-file");
		if (!onlyDevNullOutput) return false;
	}
	if (words.some((word) => /^--?(?:data|form)(?:-|=|$)/i.test(word))) return false;

	const requestIndex = words.findIndex((word) => word === "-X" || word === "--request");
	const attachedRequest = words.find((word) => /^-X\S+/.test(word))?.slice(2);
	const method = attachedRequest ?? (requestIndex >= 0 ? words[requestIndex + 1] : undefined);
	return !method || method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD";
}

function isSafeSegment(segment: string): boolean {
	const words = shellWords(segment);
	if (!words || words.length === 0) return false;
	const command = words[0].toLowerCase();

	if (command === "git") return isSafeGitCommand(words);
	if (command === "curl") return isSafeCurlCommand(words);
	if (command === "wget") {
		return words.some((word, index) => word === "--output-document=-" || (word === "-O" && words[index + 1] === "-"));
	}
	if (command === "find") {
		return !hasOption(words, "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls");
	}
	if (command === "sort" || command === "diff") {
		return !hasOption(words, "-o", "--output", "--compress-program", "--ext-diff", "--textconv");
	}
	if (command === "uniq") return words.slice(1).filter((word) => !word.startsWith("-")).length <= 1;
	if (command === "sed") {
		return words.includes("-n") && !hasOption(words, "-i", "--in-place") && !words.some((word) => /(?:^|[;{}0-9$])w\s+/i.test(word));
	}
	if (command === "awk") return !words.some((word) => /\bsystem\s*\(|>/.test(word));
	if (command === "less") return !hasOption(words, "-o", "-O", "--log-file");
	if (command === "rg") return !hasOption(words, "--pre");
	if (command === "env") {
		return words.slice(1).every((word) => word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
	}
	if (command === "node" || command === "python" || command === "python3") {
		return words.length === 2 && (words[1] === "--version" || words[1] === "-V");
	}
	if (["npm", "yarn", "pnpm"].includes(command)) {
		const queryCommands = new Set(["list", "ls", "view", "info", "search", "outdated", "audit", "why"]);
		return queryCommands.has(words[1]?.toLowerCase()) && !hasOption(words, "--fix");
	}

	return SAFE_PATTERNS.some((pattern) => pattern.test(segment));
}

export function isReadOnlyCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed || hasUnsafeWriteRedirection(trimmed)) return false;

	// Every segment (split on ;, &&, ||, |, &, newlines, subshells, and command
	// substitutions) must independently match the allowlist. This prevents a safe
	// leading command from hiding an arbitrary continuation.
	const segments = splitCommandSegments(trimmed);
	return segments.length > 0 && segments.every(isSafeSegment);
}

function cleanInlineText(text: string): string {
	let cleaned = text
		.replace(/^\[[ x-]\]\s+/i, "")
		.replace(/```\w*/g, "")
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	return cleaned;
}

function cleanDetails(lines: string[]): string | undefined {
	const details = lines
		.filter((line) => !/^\s*```/.test(line))
		.map((line) => line.trim())
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return details ? cleanInlineText(details) : undefined;
}

function planSection(message: string): string | undefined {
	const header = message.match(/(?:^|\n)\s*(?:(?:#{1,6}\s*)?\*{0,2}Plan\*{0,2}\s*:|#{1,6}\s*Plan)\s*\n/i);
	if (header?.index === undefined) return undefined;

	const rest = message.slice(header.index + header[0].length);
	const nextHeader = rest.search(/\n\s*(?:#{1,6}\s+|\*{0,2}[A-Z][\w\s-]{1,40}\*{0,2}:\s*\n)/);
	return nextHeader >= 0 ? rest.slice(0, nextHeader) : rest;
}

type DraftItem = { title: string; continuation: string[] };

function parseList(section: string, kind: "numbered" | "bulleted"): PlanItem[] {
	const matcher =
		kind === "numbered" ? /^(\s*)\d+[.)]\s+(?:\[[ x-]\]\s*)?(.*\S)\s*$/ : /^(\s*)[-*]\s+(?:\[[ x-]\]\s*)?(.*\S)\s*$/;
	const drafts: DraftItem[] = [];
	let current: DraftItem | undefined;
	let baseIndent: number | undefined;
	let inFence = false;

	for (const line of section.split("\n")) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			if (current) current.continuation.push(line);
			continue;
		}

		const match = inFence ? undefined : line.match(matcher);
		const indent = match?.[1]?.replace(/\t/g, "    ").length;
		if (match && (baseIndent === undefined || indent === baseIndent)) {
			baseIndent ??= indent;
			if (current) drafts.push(current);
			current = { title: match[2] ?? "", continuation: [] };
			continue;
		}
		if (current) current.continuation.push(line);
	}
	if (current) drafts.push(current);

	return drafts.flatMap((draft, index) => {
		const text = cleanInlineText(draft.title);
		if (text.length <= 3 || text.startsWith("/")) return [];
		return [
			{
				step: index + 1,
				text,
				details: cleanDetails(draft.continuation),
				completed: false,
			},
		];
	});
}

export function extractPlanItems(message: string): PlanItem[] {
	const section = planSection(message);
	if (section === undefined) return [];
	const numbered = parseList(section, "numbered");
	return numbered.length > 0 ? numbered : parseList(section, "bulleted");
}

export function formatPlanItem(item: Pick<PlanItem, "text">, maxLength = 100): string {
	const text = item.text.replace(/\s+/g, " ").trim();
	if (text.length <= maxLength) return text;
	const candidate = text.slice(0, Math.max(1, maxLength - 1));
	const lastSpace = candidate.lastIndexOf(" ");
	const cutAt = lastSpace >= Math.floor(maxLength * 0.6) ? lastSpace : candidate.length;
	return `${candidate.slice(0, cutAt).trimEnd()}…`;
}

export function extractDoneSteps(message: string): number[] {
	const steps = new Set<number>();
	for (const match of message.matchAll(/\[DONE:([\d,\s-]+)\]/gi)) {
		const raw = match[1] ?? "";
		for (const part of raw.split(/\s*,\s*/)) {
			const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
			if (range) {
				const start = Number(range[1]);
				const end = Number(range[2]);
				for (let step = Math.min(start, end); step <= Math.max(start, end); step++) steps.add(step);
				continue;
			}
			const step = Number(part.trim());
			if (Number.isFinite(step) && step > 0) steps.add(step);
		}
	}
	return [...steps];
}

export function markCompletedSteps(text: string, items: PlanItem[]): number {
	let changed = 0;
	for (const step of extractDoneSteps(text)) {
		const item = items.find((candidate) => candidate.step === step);
		if (item && !item.completed) {
			item.completed = true;
			changed++;
		}
	}
	return changed;
}
