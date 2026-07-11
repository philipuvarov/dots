export interface PlanItem {
	step: number;
	text: string;
	completed: boolean;
}

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\b(npm|yarn|pnpm)\s+(install|uninstall|update|ci|link|publish|add|remove)\b/i,
	/\b(pip|pipx|uv)\s+(install|uninstall|add|remove)\b/i,
	/\b(apt|apt-get|dnf|yum|pacman|brew)\s+(install|remove|purge|update|upgrade|add)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone|clean)\b/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
	/\bservice\s+\S+\s+(start|stop|restart)\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	/\|\s*(sh|bash|zsh|fish|python|python3|perl|ruby|node|deno|bun)\b/i,
	/\b(sh|bash|zsh|fish)\s+-c\b/i,
	/\bcurl\b[^\n]*(\s-o\s|\s--output\b|\s-O\b)/i,
	/\bwget\b(?!(?:[^\n]*\s-O\s*-\b))/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/i,
	/^\s*head\b/i,
	/^\s*tail\b/i,
	/^\s*less\b/i,
	/^\s*more\b/i,
	/^\s*grep\b/i,
	/^\s*find\b/i,
	/^\s*ls\b/i,
	/^\s*pwd\b/i,
	/^\s*cd\b/i,
	/^\s*echo\b/i,
	/^\s*printf\b/i,
	/^\s*wc\b/i,
	/^\s*sort\b/i,
	/^\s*uniq\b/i,
	/^\s*diff\b/i,
	/^\s*file\b/i,
	/^\s*stat\b/i,
	/^\s*du\b/i,
	/^\s*df\b/i,
	/^\s*tree\b/i,
	/^\s*which\b/i,
	/^\s*whereis\b/i,
	/^\s*type\b/i,
	/^\s*env\b/i,
	/^\s*printenv\b/i,
	/^\s*uname\b/i,
	/^\s*whoami\b/i,
	/^\s*id\b/i,
	/^\s*date\b/i,
	/^\s*cal\b/i,
	/^\s*uptime\b/i,
	/^\s*ps\b/i,
	/^\s*top\b/i,
	/^\s*htop\b/i,
	/^\s*free\b/i,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-files|ls-tree|grep)\b/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*yarn\s+(list|info|why|audit)\b/i,
	/^\s*pnpm\s+(list|view|info|search|outdated|audit)\b/i,
	/^\s*node\s+--version\b/i,
	/^\s*python3?\s+--version\b/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-\b/i,
	/^\s*jq\b/i,
	/^\s*sed\s+-n\b/i,
	/^\s*awk\b/i,
	/^\s*rg\b/i,
	/^\s*fd\b/i,
	/^\s*bat\b/i,
	/^\s*eza\b/i,
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

export function isReadOnlyCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;

	// Every segment (split on ;, &&, ||, |, &, newlines, subshells, and command
	// substitutions) must independently match a safe pattern. This prevents
	// bypasses like `cat x; python evil.py` or `ls $(python evil.py)` where only
	// the leading command is read-only.
	const segments = splitCommandSegments(trimmed);
	if (segments.length === 0) return false;
	return segments.every((segment) => SAFE_PATTERNS.some((pattern) => pattern.test(segment)));
}

function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^\[[ x-]\]\s+/i, "")
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	if (cleaned.length > 120) cleaned = `${cleaned.slice(0, 117)}...`;
	return cleaned;
}

export function extractPlanItems(message: string): PlanItem[] {
	const header = message.match(/(?:^|\n)\s*(?:(?:#{1,6}\s*)?\*{0,2}Plan\*{0,2}\s*:|#{1,6}\s*Plan)\s*\n/i);
	if (!header?.index && header?.index !== 0) return [];

	const planStart = header.index + header[0].length;
	const rest = message.slice(planStart);
	const nextHeader = rest.search(/\n\s*(?:#{1,6}\s+|\*{0,2}[A-Z][\w\s-]{1,40}\*{0,2}:\s*\n)/);
	const section = nextHeader >= 0 ? rest.slice(0, nextHeader) : rest;

	const items: PlanItem[] = [];
	const numbered = /^\s*(\d+)[.)]\s+(?:\[[ x-]\]\s*)?(.*\S)\s*$/gm;
	for (const match of section.matchAll(numbered)) {
		const text = cleanStepText(match[2] ?? "");
		if (text.length > 3 && !text.startsWith("/")) {
			items.push({ step: items.length + 1, text, completed: false });
		}
	}

	if (items.length > 0) return items;

	const bullets = /^\s*[-*]\s+(?:\[[ x-]\]\s*)?(.*\S)\s*$/gm;
	for (const match of section.matchAll(bullets)) {
		const text = cleanStepText(match[1] ?? "");
		if (text.length > 3 && !text.startsWith("/")) {
			items.push({ step: items.length + 1, text, completed: false });
		}
	}
	return items;
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
