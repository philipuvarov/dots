import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type KeybindingsManager, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

interface DangerousMatch {
	id: string;
	reason: string;
}

interface Segment {
	words: string[];
	before?: string;
	after?: string;
}

type PathAccess = "read" | "write";

const PROCEED = "Proceed";
const BLOCK = "Block";
const MAX_COMMAND_CHARS = 4_000;
const GUARDRAIL_DIALOG_MAX_ROWS = 40;
const GUARDRAIL_DIALOG_MIN_PREVIEW_ROWS = 3;
const COMMAND_SEPARATORS = new Set([";", "|", "||", "&&", "&", "\n", "(", ")"]);
const SHELLS = new Set(["bash", "sh", "zsh", "fish", "ksh", "dash"]);
const PRIVILEGE_COMMANDS = new Set(["sudo", "doas", "pkexec", "su"]);
const DOWNLOAD_COMMANDS = new Set(["curl", "wget", "fetch", "aria2c"]);
const EXECUTION_WRAPPER_COMMANDS = new Set([
	"chrt",
	"exec",
	"flock",
	"gtimeout",
	"ionice",
	"nice",
	"nohup",
	"prlimit",
	"script",
	"setsid",
	"stdbuf",
	"taskset",
	"timeout",
	"unbuffer",
	"watch",
]);
const READ_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOL_NAMES = new Set(["write", "edit"]);
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "{", "}", "!", "[[", "]]"]);
const SHELL_WRITE_PATH_COMMANDS = new Set(["chmod", "chown", "cp", "ln", "mv", "rm", "rmdir", "tee", "touch", "truncate", "unlink"]);
const FILE_REFERENCE_COMMANDS = new Set([
	"awk",
	"base64",
	"cat",
	"chmod",
	"chown",
	"cp",
	"curl",
	"find",
	"grep",
	"gunzip",
	"gzip",
	"head",
	"install",
	"less",
	"ln",
	"ls",
	"more",
	"mv",
	"nl",
	"od",
	"openssl",
	"perl",
	"rg",
	"rm",
	"rmdir",
	"rsync",
	"scp",
	"sed",
	"ssh",
	"strings",
	"tail",
	"tar",
	"tee",
	"touch",
	"truncate",
	"unlink",
	"unzip",
	"wget",
	"xxd",
	"zip",
]);
const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const CONTAINER_GLOBAL_OPTIONS_WITH_VALUE = new Set([
	"--config",
	"--connection",
	"--context",
	"--cgroup-manager",
	"--cni-config-dir",
	"--conmon",
	"--events-backend",
	"--hooks-dir",
	"--host",
	"--identity",
	"--log-level",
	"--module",
	"--namespace",
	"--network-cmd-path",
	"--out",
	"--registries-conf",
	"--root",
	"--runroot",
	"--runtime",
	"--ssh",
	"--storage-driver",
	"--storage-opt",
	"--tlscacert",
	"--tlscert",
	"--tlskey",
	"--tmpdir",
	"--url",
	"--volumepath",
]);
const CONTAINER_GLOBAL_SHORT_OPTIONS_WITH_VALUE = new Set(["-c", "-H", "-l"]);
const HOME_DIR = normalize(homedir());
const XDG_CONFIG_HOME = normalize(process.env.XDG_CONFIG_HOME || resolve(HOME_DIR, ".config"));
const XDG_DATA_HOME = normalize(process.env.XDG_DATA_HOME || resolve(HOME_DIR, ".local/share"));
const XDG_CACHE_HOME = normalize(process.env.XDG_CACHE_HOME || resolve(HOME_DIR, ".cache"));
const XDG_STATE_HOME = normalize(process.env.XDG_STATE_HOME || resolve(HOME_DIR, ".local/state"));
const XDG_RUNTIME_HOME = normalize(process.env.XDG_RUNTIME_DIR || (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : ""));
const DEFAULT_WRITE_DEVICE_ALLOWLIST = ["/dev/null", "/dev/stdout", "/dev/stderr"].map((path) => normalize(path));
const SYSTEM_WRITE_DIRS = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/dev", "/proc", "/sys", "/boot"];
const SENSITIVE_HOME_PATHS = [
	".ssh",
	".aws",
	".gnupg",
	".kube",
	".azure",
	".config/gh",
	".config/gcloud",
	".docker/config.json",
	".npmrc",
	".pypirc",
	".netrc",
	".git-credentials",
	".local/share/keyrings",
].map((path) => normalize(resolve(HOME_DIR, path)));
const SHELL_CONFIG_PATHS = [
	".bashrc",
	".bash_profile",
	".bash_login",
	".profile",
	".zshrc",
	".zprofile",
	".zlogin",
	".zshenv",
	".config/fish/config.fish",
	".config/fish/conf.d",
].map((path) => normalize(resolve(HOME_DIR, path)));
const PERSISTENCE_HOME_PATHS = [
	{ id: "ssh-authorized-keys", path: normalize(resolve(HOME_DIR, ".ssh/authorized_keys")), reason: "SSH authorized_keys can persist remote login access." },
	{ id: "systemd-user", path: normalize(resolve(XDG_CONFIG_HOME, "systemd/user")), reason: "systemd user units can start programs automatically on login or boot." },
	{ id: "systemd-user-data", path: normalize(resolve(XDG_DATA_HOME, "systemd/user")), reason: "systemd user units can start programs automatically on login or boot." },
	{ id: "desktop-autostart", path: normalize(resolve(XDG_CONFIG_HOME, "autostart")), reason: "desktop autostart entries can run commands automatically after login." },
];
const KNOWN_PATH_ENV_VARS: Record<string, string> = {
	HOME: HOME_DIR,
	XDG_CACHE_HOME,
	XDG_CONFIG_HOME,
	XDG_DATA_HOME,
	XDG_RUNTIME_DIR: XDG_RUNTIME_HOME,
	XDG_STATE_HOME,
};
const UNSAFE_CONTAINER_CAPS = new Set(["ALL", "AUDIT_CONTROL", "DAC_READ_SEARCH", "MKNOD", "NET_ADMIN", "SYS_ADMIN", "SYS_MODULE", "SYS_PTRACE", "SYS_RAWIO"]);
const SENSITIVE_FILE_NAMES = new Set([
	".env",
	".netrc",
	".npmrc",
	".pypirc",
	".git-credentials",
	"credentials",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	"id_rsa",
	"secrets.json",
	"secrets.toml",
	"secrets.yaml",
	"secrets.yml",
]);
const SENSITIVE_FILE_EXTENSIONS = [".key", ".pem", ".p12", ".pfx", ".tfstate"];

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

export function findDangerousCommandMatches(command: string, depth = 0, cwd = process.cwd()): DangerousMatch[] {
	if (depth > 3) return [];

	const matches: DangerousMatch[] = [];
	collectEmbeddedShellMatches(command, matches, depth, cwd);
	if (looksLikeForkBomb(command)) {
		addMatch(matches, {
			id: "fork-bomb",
			reason: "Fork bomb pattern can spawn unbounded processes and make the machine unusable.",
		});
	}

	const tokens = tokenizeShell(command);
	const segments = splitSegments(tokens);
	collectPipelineMatches(segments, matches);

	for (const segment of segments) {
		collectSegmentMatches(segment.words, matches, depth, cwd);
	}

	return matches;
}

function collectSegmentMatches(words: string[], matches: DangerousMatch[], depth: number, cwd: string) {
	if (depth > 3) return;

	const info = commandInfo(words, false);
	if (!info) return;

	const { command, index } = info;
	const args = words.slice(index + 1);
	const commandWords = words.slice(index);

	if (EXECUTION_WRAPPER_COMMANDS.has(command)) {
		collectShellRedirectionMatches(commandWords, cwd, matches);
		const nested = unwrapExecutionWrapper(command, args);
		if (nested?.command) {
			for (const match of findDangerousCommandMatches(nested.command, depth + 1, cwd)) addMatch(matches, match);
		} else if (nested?.words && nested.words.length > 0) {
			collectSegmentMatches(nested.words, matches, depth + 1, cwd);
		}
		return;
	}

	if (PRIVILEGE_COMMANDS.has(command)) {
		addMatch(matches, {
			id: `privilege:${command}`,
			reason: `${command} runs with elevated privileges and can change system files or settings outside normal user permissions.`,
		});

		if (command === "su") {
			const nestedCommand = suCommandArgument(args);
			if (nestedCommand) {
				for (const match of findDangerousCommandMatches(nestedCommand, depth + 1, cwd)) addMatch(matches, match);
			}
		}

		const nested = commandInfo(words, true);
		if (nested && nested.index > index) collectSegmentMatches(words.slice(nested.index), matches, depth + 1, cwd);
		return;
	}

	if (SHELLS.has(command)) {
		const nestedCommand = findShellDashCArgument(args);
		if (nestedCommand) {
			if (containsDownloadCommandSubstitution(nestedCommand)) {
				addMatch(matches, {
					id: "download-substitution-shell",
					reason: "Passing $(curl ...) or $(wget ...) output to a shell executes remote code before inspection.",
				});
			}
			for (const match of findDangerousCommandMatches(nestedCommand, depth + 1, cwd)) addMatch(matches, match);
		}
	}

	if (command === "eval" && args.length > 0) {
		const nestedCommand = args.join(" ");
		if (containsDownloadCommandSubstitution(nestedCommand)) {
			addMatch(matches, {
				id: "download-substitution-eval",
				reason: "eval of $(curl ...) or $(wget ...) output executes remote code before inspection.",
			});
		}
		for (const match of findDangerousCommandMatches(nestedCommand, depth + 1, cwd)) addMatch(matches, match);
	}

	if (command === "xargs") {
		const nested = xargsCommandWords(args);
		if (nested.length > 0) collectSegmentMatches(nested, matches, depth + 1, cwd);
	}

	collectCoreCommandMatches(command, args, commandWords, matches, cwd);
}

function findToolPathMatches(toolName: string, input: unknown, cwd: string): DangerousMatch[] {
	const access: PathAccess | undefined = WRITE_TOOL_NAMES.has(toolName)
		? "write"
		: READ_TOOL_NAMES.has(toolName)
			? "read"
			: undefined;
	if (!access || !isRecord(input)) return [];

	const matches: DangerousMatch[] = [];
	const rawPaths = toolPathInputs(toolName, input);
	const readTargetsOutsideCwd = access === "read" && rawPaths.length > 0 && rawPaths.every((rawPath) => isReadOutsideCwd(rawPath, cwd));

	for (const rawPath of rawPaths) {
		for (const match of collectPathMatches(rawPath, cwd, access)) addMatch(matches, match);
	}

	if (!readTargetsOutsideCwd && toolName === "grep" && typeof input.glob === "string") {
		const globOutsideCwd = looksLikePathCandidate(input.glob) && isReadOutsideCwd(input.glob, cwd);
		if (!globOutsideCwd) collectSensitivePatternMatches(input.glob, "grep glob", matches);
		if (!globOutsideCwd && looksLikePathCandidate(input.glob)) {
			for (const match of collectPathMatches(input.glob, cwd, "read")) addMatch(matches, match);
		}
	}
	if (!readTargetsOutsideCwd && toolName === "find" && typeof input.pattern === "string") {
		collectSensitivePatternMatches(input.pattern, "find pattern", matches);
	}

	return matches;
}

function toolPathInputs(toolName: string, input: Record<string, unknown>): string[] {
	const path = typeof input.path === "string" ? input.path : undefined;
	if (toolName === "grep" || toolName === "find" || toolName === "ls") return [path ?? "."];
	return path ? [path] : [];
}

function formatToolRequest(toolName: string, input: unknown): string {
	if (toolName === "grep" || toolName === "find") return `${toolName}: ${safeStringify(input)}`;
	if (isRecord(input)) {
		const paths = toolPathInputs(toolName, input);
		if (paths.length > 0) return `${toolName}: ${paths.join(", ")}`;
	}

	return `${toolName}: ${safeStringify(input)}`;
}

function collectPathMatches(rawPath: string, cwd: string, access: PathAccess): DangerousMatch[] {
	const matches: DangerousMatch[] = [];
	const lexicalPath = resolveLexicalGuardPath(rawPath, cwd);
	const resolvedPath = canonicalizeExistingPath(lexicalPath);
	const resolvedCwd = resolveGuardPath(".", cwd);

	if (access === "read" && !isPathInsideOrEqual(resolvedPath, resolvedCwd)) return matches;
	if (access === "write" && isAllowedDeviceWrite(lexicalPath, resolvedPath)) return matches;

	if (access === "write" && !isPathInsideOrEqual(resolvedPath, resolvedCwd)) {
		addMatch(matches, {
			id: "write-outside-cwd",
			reason: `Write target resolves outside current working directory (${resolvedPath}).`,
		});
	}

	if (access === "write" && SYSTEM_WRITE_DIRS.some((dir) => isPathInsideOrEqual(resolvedPath, dir))) {
		addMatch(matches, {
			id: "system-write",
			reason: `Writing under system path ${resolvedPath} can damage OS files, devices, or runtime state.`,
		});
	}

	if (access === "write" && SHELL_CONFIG_PATHS.some((path) => isPathInsideOrEqual(resolvedPath, path) || isPathInsideOrEqual(lexicalPath, path))) {
		addMatch(matches, {
			id: "shell-config-write",
			reason: "Writing shell startup config can persist commands that run in future terminal sessions.",
		});
	}

	if (access === "write") {
		const persistence = persistencePathReason(resolvedPath) ?? persistencePathReason(lexicalPath);
		if (persistence) {
			addMatch(matches, {
				id: `persistence-write:${persistence.id}`,
				reason: `Writing ${resolvedPath} can create or alter persistence. ${persistence.reason}`,
			});
		}
	}

	const sensitive = sensitivePathReason(resolvedPath) ?? sensitivePathReason(lexicalPath);
	if (sensitive) {
		addMatch(matches, {
			id: `sensitive-${access}:${sensitive.id}`,
			reason: `${access === "write" ? "Writing" : "Reading"} ${resolvedPath} touches sensitive material. ${sensitive.reason}`,
		});
	}

	return matches;
}

function collectSensitivePatternMatches(pattern: string, label: string, matches: DangerousMatch[]) {
	const lower = pattern.toLowerCase();
	if (
		lower.includes(".env") ||
		lower.includes("id_rsa") ||
		lower.includes("id_ed25519") ||
		lower.includes("secret") ||
		lower.includes("credential") ||
		SENSITIVE_FILE_EXTENSIONS.some((extension) => lower.includes(extension))
	) {
		addMatch(matches, {
			id: `sensitive-pattern:${label}`,
			reason: `${label} targets filenames commonly used for secrets or private keys.`,
		});
	}
}

function collectEmbeddedShellMatches(command: string, matches: DangerousMatch[], depth: number, cwd: string) {
	if (depth >= 3) return;
	for (const nestedCommand of extractEmbeddedCommands(command)) {
		for (const match of findDangerousCommandMatches(nestedCommand, depth + 1, cwd)) addMatch(matches, match);
	}
}

function extractEmbeddedCommands(command: string): string[] {
	const nested: string[] = [];
	for (const match of command.matchAll(/\$\(([^)]{1,4000})\)/g)) nested.push(match[1]);
	for (const match of command.matchAll(/`([^`]{1,4000})`/g)) nested.push(match[1]);
	return nested;
}

function collectSourceAndInterpreterMatches(command: string, args: string[], matches: DangerousMatch[]) {
	if ((command === "source" || command === ".") && firstNonOptionArg(args)) {
		addMatch(matches, {
			id: "source-script",
			reason: "source/. executes another file inside the current shell, so hidden commands can alter this session or shell state.",
		});
	}

	if (isShellScriptExecution(command, args)) {
		addMatch(matches, {
			id: "shell-script-execution",
			reason: "Running a shell script can execute arbitrary commands from a file that was not shown in this prompt.",
		});
	}

	if (isInlineInterpreterExecution(command, args)) {
		addMatch(matches, {
			id: "inline-interpreter-execution",
			reason: `${command} inline code execution can read, write, delete, or exfiltrate files without shell command patterns being visible.`,
		});
	}
}

function collectShellSensitivePathMatches(command: string, args: string[], cwd: string, matches: DangerousMatch[]) {
	if (!FILE_REFERENCE_COMMANDS.has(command)) return;

	const fileArgs = likelyFileReferenceArgs(command, args);
	for (let index = 0; index < fileArgs.length; index++) {
		const access = shellFileArgumentAccess(command, args, index, fileArgs.length);
		for (const candidate of fileReferenceCandidates(fileArgs[index], true)) {
			for (const match of collectPathMatches(candidate, cwd, access)) addMatch(matches, match);
		}
	}
}

function collectCommandPathOptionMatches(command: string, args: string[], cwd: string, matches: DangerousMatch[]) {
	const addPath = (rawPath: string | undefined, access: PathAccess) => {
		if (!rawPath) return;
		for (const candidate of fileReferenceCandidates(rawPath, true)) {
			for (const match of collectPathMatches(candidate, cwd, access)) addMatch(matches, match);
		}
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (command === "curl") {
			if (arg === "-o" || arg === "--output" || arg === "--output-dir") addPath(args[i + 1], "write");
			else if (arg.startsWith("-o") && arg.length > 2) addPath(arg.slice(2), "write");
			else if (arg.startsWith("--output=") || arg.startsWith("--output-dir=")) addPath(arg.slice(arg.indexOf("=") + 1), "write");
			else if (arg === "-K" || arg === "--config" || arg === "--netrc-file" || arg === "--upload-file" || arg === "-T") addPath(args[i + 1], "read");
			else if (arg.startsWith("--config=") || arg.startsWith("--netrc-file=") || arg.startsWith("--upload-file=")) addPath(arg.slice(arg.indexOf("=") + 1), "read");
		}

		if (command === "wget") {
			if (arg === "-O" || arg === "--output-document" || arg === "-o" || arg === "--output-file" || arg === "-a" || arg === "--append-output" || arg === "-P" || arg === "--directory-prefix") addPath(args[i + 1], "write");
			else if ((arg.startsWith("-O") || arg.startsWith("-o") || arg.startsWith("-a") || arg.startsWith("-P")) && arg.length > 2) addPath(arg.slice(2), "write");
			else if (arg.startsWith("--output-document=") || arg.startsWith("--output-file=") || arg.startsWith("--append-output=") || arg.startsWith("--directory-prefix=")) addPath(arg.slice(arg.indexOf("=") + 1), "write");
			else if (arg === "-i" || arg === "--input-file") addPath(args[i + 1], "read");
			else if (arg.startsWith("--input-file=")) addPath(arg.slice(arg.indexOf("=") + 1), "read");
		}

		if (command === "tar") {
			if ((arg === "-C" || arg === "--directory") && tarExtracts(args)) addPath(args[i + 1], "write");
			else if (arg.startsWith("-C") && arg.length > 2 && tarExtracts(args)) addPath(arg.slice(2), "write");
			else if (arg.startsWith("--directory=") && tarExtracts(args)) addPath(arg.slice(arg.indexOf("=") + 1), "write");
		}

		if (command === "unzip") {
			if (arg === "-d") addPath(args[i + 1], "write");
			else if (arg.startsWith("-d") && arg.length > 2) addPath(arg.slice(2), "write");
		}
	}
}

function collectShellRedirectionMatches(words: string[], cwd: string, matches: DangerousMatch[]) {
	for (let i = 0; i < words.length; i++) {
		if (words[i] !== ">" && words[i] !== "<") continue;

		const operator = words[i];
		let targetIndex = i + 1;
		while (words[targetIndex] === operator) targetIndex++;

		// << and <<< are heredocs / here-strings; their next word is delimiter or data, not a path.
		if (operator === "<" && targetIndex - i > 1) {
			i = targetIndex;
			continue;
		}

		const target = words[targetIndex];
		if (!target || target === "&" || /^&?\d+$/.test(target)) {
			i = targetIndex;
			continue;
		}

		for (const match of collectPathMatches(target, cwd, operator === "<" ? "read" : "write")) addMatch(matches, match);
		i = targetIndex;
	}
}

function shellFileArgumentAccess(command: string, args: string[], index: number, total: number): PathAccess {
	if (command === "cp" || command === "mv" || command === "ln" || command === "install" || command === "rsync" || command === "scp") return index === total - 1 ? "write" : "read";
	if ((command === "sed" && hasSedInPlace(args)) || (command === "perl" && hasPerlInPlace(args))) return "write";
	return SHELL_WRITE_PATH_COMMANDS.has(command) ? "write" : "read";
}

function likelyFileReferenceArgs(command: string, args: string[]): string[] {
	if (command === "find") return findPathArgs(args);

	const values = args.filter((arg) => !isOptionOnly(arg));
	if (command !== "grep" && command !== "rg" && command !== "sed" && command !== "awk") return values;

	const firstPathIndex = values.findIndex((arg) => looksLikePathCandidate(arg));
	if (firstPathIndex !== -1) return values.slice(firstPathIndex);
	return values.length > 1 ? values.slice(1) : [];
}

function findPathArgs(args: string[]): string[] {
	const paths: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") continue;
		if (["-H", "-L", "-P"].includes(arg)) continue;
		if (arg === "-D" || arg === "-O") {
			index++;
			continue;
		}
		if (arg.startsWith("-") || ["!", "(", ")", ","].includes(arg)) break;
		paths.push(arg);
	}
	return paths.length > 0 ? paths : ["."];
}

function fileReferenceCandidates(arg: string, includePlain = false): string[] {
	const candidates = [arg];
	const equalsIndex = arg.indexOf("=");
	if (equalsIndex !== -1) candidates.push(arg.slice(equalsIndex + 1));

	return candidates
		.map(stripPathArgumentDecorators)
		.filter((candidate) => candidate.length > 0 && (includePlain || looksLikePathCandidate(candidate)));
}

function looksLikePathCandidate(value: string): boolean {
	const candidate = stripPathArgumentDecorators(value);
	const expanded = expandHomePath(expandKnownPathVariables(candidate));
	const base = basename(expanded).toLowerCase();
	return candidate.startsWith("~") ||
		candidate.startsWith("$HOME") ||
		candidate.startsWith("${HOME}") ||
		candidate.startsWith("$XDG_") ||
		candidate.startsWith("${XDG_") ||
		expanded.startsWith("/") ||
		expanded.startsWith("./") ||
		expanded === ".." ||
		expanded.startsWith("../") ||
		expanded.includes("/.env") ||
		base === ".env" ||
		base.startsWith(".env.") ||
		SENSITIVE_FILE_NAMES.has(base) ||
		SENSITIVE_FILE_EXTENSIONS.some((extension) => base.endsWith(extension));
}

function stripPathArgumentDecorators(value: string): string {
	let candidate = value.trim();
	while (candidate.startsWith("@")) candidate = candidate.slice(1);
	return candidate.replace(/[,:;]+$/g, "");
}

function isOptionOnly(arg: string): boolean {
	if (arg === "--") return true;
	if (arg.startsWith("--") && !arg.includes("=") && !arg.includes("/")) return true;
	return /^-[A-Za-z]+$/.test(arg);
}

function hasSedInPlace(args: string[]): boolean {
	return args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="));
}

function hasPerlInPlace(args: string[]): boolean {
	return args.some((arg) => /^-[A-Za-z0-9]*i[A-Za-z0-9]*$/.test(arg));
}

function tarExtracts(args: string[]): boolean {
	return args.some((arg) => arg === "--extract" || (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("x")) || /^[A-Za-z]*x[A-Za-z]*$/.test(arg));
}

function isShellScriptExecution(command: string, args: string[]): boolean {
	return SHELLS.has(command) && !findShellDashCArgument(args) && firstNonOptionArg(args) !== undefined;
}

function isInlineInterpreterExecution(command: string, args: string[]): boolean {
	const readsInlineStdin = args.includes("-") || args.includes("<");
	if (/^python(?:\d+(?:\.\d+)*)?$/.test(command)) return hasShortFlag(args, "c") || readsInlineStdin;
	if (command === "node") return hasShortFlag(args, "e") || hasShortFlag(args, "p") || hasLongOption(args, "eval") || hasLongOption(args, "print") || readsInlineStdin;
	if (command === "perl" || command === "ruby" || command === "osascript" || command === "rscript") return hasShortFlag(args, "e") || hasLongOption(args, "eval") || readsInlineStdin;
	if (command === "php") return hasShortFlag(args, "r") || readsInlineStdin;
	if (command === "deno") return firstNonOptionArg(args) === "eval";
	if (command === "bun") return hasShortFlag(args, "e") || hasLongOption(args, "eval") || readsInlineStdin;
	return false;
}

function isStdinCodeInterpreter(command: string): boolean {
	return /^python(?:\d+(?:\.\d+)*)?$/.test(command) ||
		["node", "perl", "ruby", "php", "rscript", "osascript", "deno", "bun", "lua"].includes(command);
}

function containsDownloadCommandSubstitution(command: string): boolean {
	return extractEmbeddedCommands(command).some((nestedCommand) => {
		const tokens = tokenizeShell(nestedCommand);
		return splitSegments(tokens).some((segment) => {
			const info = commandInfo(segment.words, true);
			return !!info && DOWNLOAD_COMMANDS.has(info.command);
		});
	});
}

function firstNonOptionArg(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return args[i + 1];
		if (arg.startsWith("-")) continue;
		return arg;
	}
}

function resolveGuardPath(rawPath: string, cwd: string): string {
	return canonicalizeExistingPath(resolveLexicalGuardPath(rawPath, cwd));
}

function resolveLexicalGuardPath(rawPath: string, cwd: string): string {
	const expanded = expandHomePath(expandKnownPathVariables(stripPathArgumentDecorators(rawPath)));
	return normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}

function expandHomePath(path: string): string {
	if (path === "~") return HOME_DIR;
	if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(HOME_DIR, path.slice(2));
	return path;
}

function expandKnownPathVariables(path: string): string {
	return path
		.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (original, name: string) => knownPathVariableValue(name) ?? original)
		.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (original, name: string) => knownPathVariableValue(name) ?? original);
}

function knownPathVariableValue(name: string): string | undefined {
	const value = KNOWN_PATH_ENV_VARS[name] || process.env[name];
	if (!value || value.includes(":")) return undefined;
	const expanded = expandHomePath(value);
	return isAbsolute(expanded) ? normalize(expanded) : undefined;
}

function canonicalizeExistingPath(path: string, depth = 0): string {
	const original = normalize(path);
	if (depth > 20) return original;

	let current = original;
	const missingParts: string[] = [];
	while (true) {
		const symlinkTarget = readSymlinkTarget(current);
		if (symlinkTarget) return canonicalizeExistingPath(resolve(symlinkTarget, ...missingParts), depth + 1);

		try {
			if (existsSync(current)) return normalize(resolve(realpathSync.native(current), ...missingParts));
		} catch {
			return original;
		}

		const parent = dirname(current);
		if (parent === current) return original;
		missingParts.unshift(basename(current));
		current = parent;
	}
}

function readSymlinkTarget(path: string): string | undefined {
	try {
		if (!lstatSync(path).isSymbolicLink()) return;
		const target = readlinkSync(path);
		return normalize(isAbsolute(target) ? target : resolve(dirname(path), target));
	} catch {
		return;
	}
}

function isReadOutsideCwd(rawPath: string, cwd: string): boolean {
	const lexicalPath = resolveLexicalGuardPath(rawPath, cwd);
	const resolvedPath = canonicalizeExistingPath(lexicalPath);
	const resolvedCwd = resolveGuardPath(".", cwd);
	return !isPathInsideOrEqual(resolvedPath, resolvedCwd);
}

function isAllowedDeviceWrite(lexicalPath: string, resolvedPath: string): boolean {
	return DEFAULT_WRITE_DEVICE_ALLOWLIST.includes(normalize(lexicalPath)) || DEFAULT_WRITE_DEVICE_ALLOWLIST.includes(normalize(resolvedPath));
}

function persistencePathReason(resolvedPath: string): { id: string; reason: string } | undefined {
	return PERSISTENCE_HOME_PATHS.find((entry) => isPathInsideOrEqual(resolvedPath, entry.path));
}

function sensitivePathReason(resolvedPath: string): { id: string; reason: string } | undefined {
	if (SENSITIVE_HOME_PATHS.some((path) => isPathInsideOrEqual(resolvedPath, path))) {
		return { id: "home-secret", reason: "This path is commonly used for credentials, private keys, or auth tokens." };
	}

	const parts = resolvedPath.split(/[\\/]+/).map((part) => part.toLowerCase());
	if (parts.some((part) => part === ".env" || part === ".envrc" || part.startsWith(".env."))) {
		return { id: "env-file", reason: ".env files commonly contain API keys and service credentials." };
	}

	const base = basename(resolvedPath).toLowerCase();
	if (SENSITIVE_FILE_NAMES.has(base)) {
		return { id: `file:${base}`, reason: "This filename is commonly used for credentials or private keys." };
	}
	if (SENSITIVE_FILE_EXTENSIONS.some((extension) => base.endsWith(extension))) {
		return { id: "secret-extension", reason: "This extension is commonly used for private keys, certificates, or state containing secrets." };
	}

	return undefined;
}

function isPathInsideOrEqual(candidate: string, parent: string): boolean {
	const relativePath = relative(normalize(parent), normalize(candidate));
	return relativePath === "" || (!!relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function collectCoreCommandMatches(command: string, args: string[], words: string[], matches: DangerousMatch[], cwd: string) {
	if (command === "rm") {
		const recursive = hasShortFlag(args, "r") || hasShortFlag(args, "R") || hasLongOption(args, "recursive") || hasLongOption(args, "dir");
		const force = hasShortFlag(args, "f") || hasLongOption(args, "force");
		if (recursive) {
			addMatch(matches, {
				id: "rm-recursive",
				reason: force
					? "Recursive force delete can permanently remove whole directory trees while suppressing prompts and missing-file errors."
					: "Recursive delete can permanently remove whole directory trees.",
			});
		}
	}

	if (command === "shred" || command === "srm") {
		addMatch(matches, {
			id: `secure-delete:${command}`,
			reason: `${command} overwrites data for secure deletion, which is intentionally hard to recover.`,
		});
	}

	if (command === "dd" && args.some((arg) => arg === "of" || arg.startsWith("of="))) {
		addMatch(matches, {
			id: "dd-output",
			reason: "dd with an output target can overwrite disks, partitions, or files byte-for-byte with little safety checking.",
		});
	}

	if (command === "mkfs" || command.startsWith("mkfs.")) {
		addMatch(matches, {
			id: "mkfs",
			reason: "mkfs formats a filesystem and can erase existing data on a device or image.",
		});
	}

	if (["wipefs", "blkdiscard", "fdisk", "sfdisk", "cfdisk", "parted", "sgdisk"].includes(command)) {
		addMatch(matches, {
			id: `disk:${command}`,
			reason: `${command} changes disk layout or filesystem metadata and can make data inaccessible.`,
		});
	}

	if (command === "chmod") {
		const recursive = hasShortFlag(args, "R") || hasLongOption(args, "recursive");
		const worldWritable = args.some(isBroadPermissionMode);
		if (recursive && worldWritable) {
			addMatch(matches, {
				id: "chmod-recursive-world-writable",
				reason: "Recursive broad chmod can make many files world-writable or executable, weakening security across a tree.",
			});
		}
	}

	if (command === "chown" && (hasShortFlag(args, "R") || hasLongOption(args, "recursive"))) {
		addMatch(matches, {
			id: "chown-recursive",
			reason: "Recursive chown can change ownership across many files and break permissions or service access.",
		});
	}

	if (isBlockDeviceRedirect(words)) {
		addMatch(matches, {
			id: "block-device-redirection",
			reason: "Redirecting output to a block device can overwrite raw disk contents and destroy data.",
		});
	}

	collectSourceAndInterpreterMatches(command, args, matches);
	collectShellRedirectionMatches(words, cwd, matches);
	collectCommandPathOptionMatches(command, args, cwd, matches);
	collectShellSensitivePathMatches(command, args, cwd, matches);

	if (command === "find") collectFindMatches(args, matches, cwd);
	if (command === "git") collectGitMatches(args, matches);
	if (command === "docker" || command === "podman") collectContainerMatches(command, args, matches);
	collectRemotePackageExecutionMatches(command, args, matches);
	collectProcessServiceDisruptionMatches(command, args, matches);
	collectPersistenceCommandMatches(command, args, matches);

	if (["shutdown", "reboot", "halt", "poweroff"].includes(command)) {
		addMatch(matches, {
			id: `power:${command}`,
			reason: `${command} can interrupt the session and stop running processes by shutting down or restarting the machine.`,
		});
	}

	if (command === "systemctl" && args.some((arg) => ["reboot", "poweroff", "halt", "suspend", "hibernate"].includes(arg))) {
		addMatch(matches, {
			id: "systemctl-power",
			reason: "systemctl power actions can interrupt the session and stop running processes.",
		});
	}

	if (command === "loginctl" && args.some((arg) => ["poweroff", "reboot", "suspend", "hibernate"].includes(arg))) {
		addMatch(matches, {
			id: "loginctl-power",
			reason: "loginctl power actions can interrupt the session and stop running processes.",
		});
	}
}

function collectRemotePackageExecutionMatches(command: string, args: string[], matches: DangerousMatch[]) {
	if (["npx", "pnpx", "bunx", "uvx"].includes(command)) {
		addMatch(matches, {
			id: `remote-package-exec:${command}`,
			reason: `${command} can download and execute package code from registries before inspection.`,
		});
	}

	const subcommand = firstNonOptionArg(args);
	if (!subcommand) return;

	if ((command === "npm" && ["exec", "x", "create", "init"].includes(subcommand)) ||
		(command === "pnpm" && ["dlx", "create"].includes(subcommand)) ||
		(command === "yarn" && ["dlx", "create"].includes(subcommand)) ||
		(command === "bun" && ["x", "create"].includes(subcommand))) {
		addMatch(matches, {
			id: `remote-package-exec:${command}-${subcommand}`,
			reason: `${command} ${subcommand} can fetch and execute package code from registries before inspection.`,
		});
	}

	if (packageInstallRunsScripts(command, subcommand, args)) {
		addMatch(matches, {
			id: `package-install-scripts:${command}`,
			reason: `${command} ${subcommand} can run package lifecycle scripts that execute arbitrary project or dependency code.`,
		});
	}
}

function collectProcessServiceDisruptionMatches(command: string, args: string[], matches: DangerousMatch[]) {
	if (command === "kill" && killTargetsAllProcesses(args)) {
		addMatch(matches, {
			id: "kill-all-processes",
			reason: "kill targeting -1 can signal every permitted process and disrupt the desktop/session.",
		});
	}

	if (command === "pkill" || command === "killall") {
		addMatch(matches, {
			id: `process-kill:${command}`,
			reason: `${command} can terminate many matching processes and disrupt running work or services.`,
		});
	}

	if (command === "systemctl") {
		const action = systemctlAction(args);
		if (action && ["stop", "disable", "mask", "restart", "reload", "kill", "isolate"].includes(action)) {
			addMatch(matches, {
				id: `systemctl-disruption:${action}`,
				reason: `systemctl ${action} can stop, disable, or disrupt services on the machine.`,
			});
		}
	}

	if (command === "service") {
		const action = args.find((arg) => ["stop", "restart", "reload", "disable"].includes(arg));
		if (action) {
			addMatch(matches, {
				id: `service-disruption:${action}`,
				reason: `service ${action} can stop or disrupt system services.`,
			});
		}
	}

	if (command === "umount" || command === "unmount" || command === "mount") {
		if (command !== "mount" || args.length > 0) {
			addMatch(matches, {
				id: `mount-change:${command}`,
				reason: `${command} can change mounted filesystems and disrupt access to files or devices.`,
			});
		}
	}

	if (command === "loginctl") {
		const action = firstNonOptionArg(args);
		if (action && ["terminate-user", "terminate-session", "kill-user", "kill-session", "lock-sessions", "enable-linger", "disable-linger"].includes(action)) {
			addMatch(matches, {
				id: `loginctl-disruption:${action}`,
				reason: `loginctl ${action} can disrupt user sessions or change session persistence behavior.`,
			});
		}
	}
}

function collectPersistenceCommandMatches(command: string, args: string[], matches: DangerousMatch[]) {
	if (command === "crontab" && !args.includes("-l")) {
		addMatch(matches, {
			id: "crontab-persistence",
			reason: "crontab changes can install, edit, or remove scheduled commands that persist across sessions.",
		});
	}

	if (command === "systemctl") {
		const action = systemctlAction(args);
		if (action && ["enable", "disable", "mask", "reenable", "link", "preset"].includes(action)) {
			const user = args.includes("--user");
			addMatch(matches, {
				id: `${user ? "systemd-user" : "systemd"}-persistence:${action}`,
				reason: `systemctl ${user ? "--user " : ""}${action} changes services that can autostart commands on login or boot.`,
			});
		}
	}
}

function collectFindMatches(args: string[], matches: DangerousMatch[], cwd: string) {
	if (args.includes("-delete")) {
		addMatch(matches, {
			id: "find-delete",
			reason: "find -delete removes every matched file and can delete large directory trees if the predicate is wrong.",
		});
	}

	for (let index = 0; index < args.length; index++) {
		if (!FIND_EXEC_ACTIONS.has(args[index])) continue;

		const nested: string[] = [];
		index++;
		for (; index < args.length; index++) {
			const arg = args[index];
			if (arg === ";" || arg === "+") break;
			if (arg !== "{}") nested.push(arg);
		}

		if (nested.length > 0) collectSegmentMatches(nested, matches, 1, cwd);
	}
}

function collectGitMatches(args: string[], matches: DangerousMatch[]) {
	const git = gitSubcommand(args);
	if (!git) return;

	if (git.subcommand === "reset" && hasLongOption(git.args, "hard")) {
		addMatch(matches, {
			id: "git-reset-hard",
			reason: "git reset --hard discards local working tree changes and can lose uncommitted work.",
		});
	}

	if (git.subcommand === "clean" && (hasShortFlag(git.args, "f") || hasLongOption(git.args, "force"))) {
		addMatch(matches, {
			id: "git-clean-force",
			reason: "git clean -f deletes untracked files; with -d or -x it can remove directories and ignored build artifacts too.",
		});
	}

	if (git.subcommand === "push" && (hasShortFlag(git.args, "f") || hasLongOption(git.args, "force") || hasLongOption(git.args, "force-with-lease"))) {
		addMatch(matches, {
			id: "git-push-force",
			reason: "Force pushing rewrites remote history and can overwrite other people's work.",
		});
	}

	if (git.subcommand === "checkout" && (hasShortFlag(git.args, "f") || hasLongOption(git.args, "force"))) {
		addMatch(matches, {
			id: "git-checkout-force",
			reason: "git checkout --force discards local changes in tracked files.",
		});
	}

	if (git.subcommand === "restore" && (hasShortFlag(git.args, "W") || hasLongOption(git.args, "worktree"))) {
		addMatch(matches, {
			id: "git-restore-worktree",
			reason: "git restore --worktree discards local working tree changes.",
		});
	}

	if (git.subcommand === "branch" && (hasShortFlag(git.args, "D") || ((hasShortFlag(git.args, "d") || hasLongOption(git.args, "delete")) && (hasShortFlag(git.args, "f") || hasLongOption(git.args, "force"))))) {
		addMatch(matches, {
			id: "git-branch-force-delete",
			reason: "git branch -D force deletes branch refs and can lose unmerged work.",
		});
	}

	if (git.subcommand === "stash" && ["clear", "drop"].includes(firstNonOptionArg(git.args) ?? "")) {
		addMatch(matches, {
			id: "git-stash-delete",
			reason: "git stash clear/drop deletes saved uncommitted work.",
		});
	}

	if (git.subcommand === "worktree" && firstNonOptionArg(git.args) === "remove" && (hasShortFlag(git.args, "f") || hasLongOption(git.args, "force"))) {
		addMatch(matches, {
			id: "git-worktree-force-remove",
			reason: "git worktree remove --force can delete a worktree even with local changes.",
		});
	}
}

function collectContainerMatches(command: string, args: string[], matches: DangerousMatch[]) {
	const parsed = containerSubcommand(args);
	if (!parsed) return;

	const { subcommand } = parsed;
	const subcommandArgs = parsed.args;

	if ((subcommand === "run" || subcommand === "create") && hasDangerousContainerRunFlag(subcommandArgs)) {
		addMatch(matches, {
			id: `${command}-dangerous-run`,
			reason: `${command} run/create with privileged mode, host namespaces, root/device/socket mounts, extra caps, or unsafe security opts can escape normal container isolation.`,
		});
	}

	if (subcommand === "system" && subcommandArgs.includes("prune")) {
		addMatch(matches, {
			id: `${command}-system-prune`,
			reason: `${command} system prune deletes containers, networks, images, and build cache that may be hard to recreate.`,
		});
	}

	if (subcommand === "volume" && (subcommandArgs.includes("rm") || subcommandArgs.includes("prune"))) {
		addMatch(matches, {
			id: `${command}-volume-delete`,
			reason: `${command} volume removal can delete persistent container data.`,
		});
	}

	if ((subcommand === "rm" || subcommand === "rmi") && (hasShortFlag(subcommandArgs, "f") || hasLongOption(subcommandArgs, "force"))) {
		addMatch(matches, {
			id: `${command}-force-remove`,
			reason: `${command} ${subcommand} --force removes containers or images without normal safeguards.`,
		});
	}
}

function containerSubcommand(args: string[]): { subcommand: string; args: string[] } | undefined {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "--") {
			const subcommand = args[index + 1];
			return subcommand ? { subcommand: subcommand.toLowerCase(), args: args.slice(index + 2) } : undefined;
		}
		if (!arg.startsWith("-")) return { subcommand: arg.toLowerCase(), args: args.slice(index + 1) };

		const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
		if (CONTAINER_GLOBAL_OPTIONS_WITH_VALUE.has(optionName)) {
			index++;
			if (!arg.includes("=") && index < args.length) index++;
			continue;
		}

		const shortOption = containerGlobalShortOptionWithValue(arg);
		if (shortOption) {
			index++;
			if (arg === shortOption && index < args.length) index++;
			continue;
		}

		index++;
	}
}

function containerGlobalShortOptionWithValue(arg: string): string | undefined {
	return [...CONTAINER_GLOBAL_SHORT_OPTIONS_WITH_VALUE].find((option) => arg === option || arg.startsWith(option));
}

function collectPipelineMatches(segments: Segment[], matches: DangerousMatch[]) {
	for (let i = 0; i < segments.length - 1; i++) {
		if (segments[i].after !== "|") continue;
		const left = pipelineCommandInfo(segments[i].words);
		const right = pipelineCommandInfo(segments[i + 1].words);
		if (!left || !right) continue;

		if (DOWNLOAD_COMMANDS.has(left.command) && SHELLS.has(right.command)) {
			addMatch(matches, {
				id: "download-pipe-shell",
				reason: "Piping downloaded content directly into a shell executes remote code before you can inspect it.",
			});
		}

		if (DOWNLOAD_COMMANDS.has(left.command) && isStdinCodeInterpreter(right.command)) {
			addMatch(matches, {
				id: "download-pipe-interpreter",
				reason: "Piping downloaded content directly into an interpreter executes remote code before inspection.",
			});
		}
	}
}

function pipelineCommandInfo(words: string[], depth = 0): { command: string; index: number } | undefined {
	if (depth > 3) return;
	const info = commandInfo(words, true);
	if (!info) return;
	if (!EXECUTION_WRAPPER_COMMANDS.has(info.command)) return info;

	const nested = unwrapExecutionWrapper(info.command, words.slice(info.index + 1));
	if (nested?.words) return pipelineCommandInfo(nested.words, depth + 1);
	if (nested?.command) {
		const segments = splitSegments(tokenizeShell(nested.command));
		return segments[0] ? pipelineCommandInfo(segments[0].words, depth + 1) : undefined;
	}
	return info;
}

function tokenizeShell(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	const flush = () => {
		if (current.length > 0) tokens.push(current);
		current = "";
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}

		if (quote) {
			if (ch === "\\" && quote === '"') {
				escaped = true;
				continue;
			}
			if (ch === quote) {
				quote = undefined;
				continue;
			}
			current += ch;
			continue;
		}

		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}

		if (ch === "#" && current.length === 0) {
			flush();
			while (i < command.length && command[i] !== "\n") i++;
			tokens.push("\n");
			continue;
		}

		if (/\s/.test(ch)) {
			flush();
			if (ch === "\n") tokens.push("\n");
			continue;
		}

		if (ch === "&" && command[i + 1] === "&") {
			flush();
			tokens.push("&&");
			i++;
			continue;
		}
		if (ch === "&" && command[i + 1] === ">") {
			flush();
			tokens.push(">");
			i++;
			continue;
		}
		if (ch === "|" && command[i + 1] === "|") {
			flush();
			tokens.push("||");
			i++;
			continue;
		}
		if ([";", "|", "&", "(", ")", "<", ">"].includes(ch)) {
			flush();
			tokens.push(ch);
			continue;
		}

		current += ch;
	}

	flush();
	return tokens.filter((token, index, all) => token !== "\n" || all[index - 1] !== "\n");
}

function splitSegments(tokens: string[]): Segment[] {
	const segments: Segment[] = [];
	let current: string[] = [];
	let before: string | undefined;

	const flush = (after?: string) => {
		if (current.length > 0) {
			segments.push({ words: current, before, after });
			current = [];
		}
		before = after;
	};

	for (const token of tokens) {
		if (COMMAND_SEPARATORS.has(token)) flush(token);
		else current.push(token);
	}
	flush();

	return segments;
}

function unwrapExecutionWrapper(command: string, args: string[]): { words?: string[]; command?: string } | undefined {
	if (command === "exec" || command === "nohup" || command === "unbuffer") return nestedWords(args);

	if (command === "timeout" || command === "gtimeout") {
		let rest = skipWrapperOptions(args, new Set(["-k", "--kill-after", "-s", "--signal"]));
		if (rest.length > 0) rest = rest.slice(1);
		return nestedWords(rest);
	}

	if (command === "nice") return nestedWords(skipNiceOptions(args));
	if (command === "setsid") return nestedWords(skipWrapperOptions(args, new Set()));
	if (command === "ionice") return nestedWords(skipWrapperOptions(args, new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid"])));
	if (command === "stdbuf") return nestedWords(skipStdbufOptions(args));
	if (command === "watch") {
		const rest = skipWatchOptions(args);
		return rest.length > 0 ? { command: rest.join(" ") } : undefined;
	}
	if (command === "taskset") {
		let rest = skipWrapperOptions(args, new Set());
		if (rest.length > 0) rest = rest.slice(1);
		return nestedWords(rest);
	}
	if (command === "chrt") {
		let rest = skipWrapperOptions(args, new Set(["--pid"]));
		if (rest.length > 0 && /^-?\d+$/.test(rest[0])) rest = rest.slice(1);
		return nestedWords(rest);
	}
	if (command === "prlimit") return nestedWords(skipWrapperOptions(args, new Set(["--pid"]), true));
	if (command === "flock") return unwrapFlock(args);
	if (command === "script") return unwrapScript(args);
}

function nestedWords(words: string[]): { words: string[] } | undefined {
	return words.length > 0 ? { words } : undefined;
}

function skipWrapperOptions(args: string[], valueOptions: Set<string>, longOptionsMayBeResources = false): string[] {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "--") return args.slice(index + 1);
		if (!arg.startsWith("-")) return args.slice(index);
		index++;
		const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
		if (valueOptions.has(optionName) && !arg.includes("=") && index < args.length) index++;
		else if (longOptionsMayBeResources && /^--[A-Za-z0-9-]+$/.test(arg) && index < args.length && !args[index].startsWith("-")) index++;
	}
	return [];
}

function skipNiceOptions(args: string[]): string[] {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "--") return args.slice(index + 1);
		if (arg === "-n" || arg === "--adjustment") index += 2;
		else if (arg.startsWith("--adjustment=")) index++;
		else if (/^-\d+$/.test(arg)) index++;
		else if (arg.startsWith("-")) index++;
		else return args.slice(index);
	}
	return [];
}

function skipStdbufOptions(args: string[]): string[] {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "--") return args.slice(index + 1);
		if (arg === "-i" || arg === "-o" || arg === "-e" || arg === "--input" || arg === "--output" || arg === "--error") index += 2;
		else if (/^-[ioe].+/.test(arg) || arg.startsWith("--input=") || arg.startsWith("--output=") || arg.startsWith("--error=")) index++;
		else if (arg.startsWith("-")) index++;
		else return args.slice(index);
	}
	return [];
}

function skipWatchOptions(args: string[]): string[] {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "--") return args.slice(index + 1);
		if (!arg.startsWith("-")) return args.slice(index);
		index++;
		const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
		if ((optionName === "-n" || optionName === "--interval") && !arg.includes("=") && index < args.length) index++;
	}
	return [];
}

function unwrapFlock(args: string[]): { words?: string[]; command?: string } | undefined {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-c" || args[i] === "--command") return args[i + 1] ? { command: args[i + 1] } : undefined;
		if (args[i].startsWith("--command=")) return { command: args[i].slice(args[i].indexOf("=") + 1) };
	}

	let rest = skipWrapperOptions(args, new Set(["-E", "--conflict-exit-code", "-w", "--wait", "--timeout"]));
	if (rest.length > 0) rest = rest.slice(1);
	return nestedWords(rest);
}

function unwrapScript(args: string[]): { command?: string } | undefined {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-c" || args[i] === "--command") return args[i + 1] ? { command: args[i + 1] } : undefined;
		if (args[i].startsWith("--command=")) return { command: args[i].slice(args[i].indexOf("=") + 1) };
	}
}

function commandInfo(words: string[], skipPrivilege: boolean): { command: string; index: number } | undefined {
	let index = 0;
	while (index < words.length) {
		const command = commandBasename(words[index]);
		if (words[index] === "--" || isAssignment(words[index]) || SHELL_KEYWORDS.has(command) || ["command", "builtin", "time", "noglob"].includes(command)) {
			index++;
			continue;
		}

		if (command === "env") {
			index++;
			while (index < words.length) {
				const arg = words[index];
				if (arg === "--") {
					index++;
					break;
				}
				if (isAssignment(arg)) {
					index++;
					continue;
				}
				if (arg === "-u" || arg === "--unset" || arg === "-S" || arg === "--split-string") {
					index += 2;
					continue;
				}
				if (arg.startsWith("--unset=") || arg.startsWith("--split-string=") || /^-[i0v]+$/.test(arg)) {
					index++;
					continue;
				}
				break;
			}
			continue;
		}

		if (skipPrivilege && PRIVILEGE_COMMANDS.has(command)) {
			index++;
			while (index < words.length && words[index].startsWith("-")) {
				const option = words[index++];
				if (["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt"].includes(option)) index++;
			}
			continue;
		}

		return { command, index };
	}
}

function findShellDashCArgument(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-c") return args[i + 1];
		if (/^-[^-]*c/.test(arg)) return args[i + 1];
	}
}

function suCommandArgument(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-c" || arg === "--command") return args[i + 1];
		if (arg.startsWith("--command=")) return arg.slice(arg.indexOf("=") + 1);
	}
}

function xargsCommandWords(args: string[]): string[] {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "--") return args.slice(index + 1);
		if (!arg.startsWith("-")) return args.slice(index);
		index++;
		if (["-I", "-E", "-P", "-n", "-s"].includes(arg)) index++;
	}
	return [];
}

function gitSubcommand(args: string[]): { subcommand: string; args: string[] } | undefined {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (!arg.startsWith("-")) return { subcommand: arg, args: args.slice(index + 1) };
		index++;
		if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(arg)) index++;
	}
}

function packageInstallRunsScripts(command: string, subcommand: string, args: string[]): boolean {
	if (args.some((arg) => arg === "--ignore-scripts" || arg === "--ignore-scripts=true")) return false;
	if (command === "npm") return ["install", "i", "ci", "update", "up", "add"].includes(subcommand);
	if (command === "pnpm") return ["install", "i", "add", "update", "up", "dlx"].includes(subcommand);
	if (command === "yarn") return ["install", "add", "up", "upgrade"].includes(subcommand);
	if (command === "bun") return ["install", "add", "update"].includes(subcommand);
	return false;
}

function killTargetsAllProcesses(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--" && args[i + 1] === "-1") return true;
		if (args[i] === "-1" && i > 0) return true;
		if (args[i] === "-9" && args[i + 1] === "-1") return true;
	}
	return false;
}

function systemctlAction(args: string[]): string | undefined {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "--") return args[index + 1];
		if (!arg.startsWith("-")) return arg;
		index++;
		if (["-M", "-H", "--machine", "--host", "--root", "--image", "--property", "-p", "--type", "-t"].includes(arg)) index++;
	}
}

function hasShortFlag(args: string[], flag: string): boolean {
	return args.some((arg) => arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes(flag));
}

function hasLongOption(args: string[], option: string): boolean {
	const prefix = `--${option}`;
	return args.some((arg) => arg === prefix || arg.startsWith(`${prefix}=`));
}

function hasDangerousContainerRunFlag(args: string[]): boolean {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		const previous = args[index - 1];

		if (arg === "--privileged" || (arg.startsWith("--privileged=") && !arg.endsWith("=false"))) return true;
		if (containerOptionValue(arg, previous, "--pid") === "host") return true;
		if (containerOptionValue(arg, previous, "--network") === "host") return true;
		if (containerOptionValue(arg, previous, "--userns") === "host") return true;
		if (containerOptionValue(arg, previous, "--uts") === "host") return true;
		if (containerOptionValue(arg, previous, "--ipc") === "host") return true;

		const volume = containerOptionValue(arg, previous, "--volume") || containerShortOptionValue(arg, previous, "-v");
		if (volume && dangerousContainerVolume(volume)) return true;

		const mount = containerOptionValue(arg, previous, "--mount");
		if (mount && dangerousContainerMount(mount)) return true;

		const device = containerOptionValue(arg, previous, "--device");
		if (device || arg === "--device" || previous === "--device") return true;

		const cap = containerOptionValue(arg, previous, "--cap-add") || containerOptionValue(arg, previous, "--cap-add=");
		if (cap && (UNSAFE_CONTAINER_CAPS.has(cap.toUpperCase()) || cap.length > 0)) return true;

		const securityOpt = containerOptionValue(arg, previous, "--security-opt");
		if (securityOpt && /(?:seccomp|apparmor)=unconfined|label=disable|systempaths=unconfined|maskedpaths=unconfined/i.test(securityOpt)) return true;

		if (containsContainerSocketPath(arg)) return true;
	}

	return false;
}

function containerOptionValue(arg: string, previous: string | undefined, option: string): string | undefined {
	if (arg.startsWith(`${option}=`)) return arg.slice(option.length + 1);
	if (previous === option) return arg;
}

function containerShortOptionValue(arg: string, previous: string | undefined, option: string): string | undefined {
	if (arg.startsWith(option) && arg.length > option.length) return arg.slice(option.length).replace(/^=/, "");
	if (previous === option) return arg;
}

function dangerousContainerVolume(value: string): boolean {
	const source = value.split(":")[0];
	return dangerousContainerHostPath(source);
}

function dangerousContainerMount(value: string): boolean {
	const fields = new Map<string, string>();
	for (const part of value.split(",")) {
		const equalsIndex = part.indexOf("=");
		if (equalsIndex === -1) continue;
		fields.set(part.slice(0, equalsIndex).trim().toLowerCase(), part.slice(equalsIndex + 1).trim());
	}
	const type = fields.get("type");
	const source = fields.get("source") || fields.get("src");
	return (!type || type === "bind") && !!source && dangerousContainerHostPath(source);
}

function dangerousContainerHostPath(rawPath: string): boolean {
	const expanded = normalize(expandHomePath(expandKnownPathVariables(rawPath)));
	return expanded === "/" ||
		["/dev", "/proc", "/sys", "/boot"].some((path) => isPathInsideOrEqual(expanded, path)) ||
		containsContainerSocketPath(expanded) ||
		!!sensitivePathReason(expanded);
}

function containsContainerSocketPath(value: string): boolean {
	return value.includes("/var/run/docker.sock") ||
		value.includes("/run/docker.sock") ||
		value.includes("/var/run/podman.sock") ||
		value.includes("/run/podman.sock");
}

function isBroadPermissionMode(arg: string): boolean {
	return ["777", "0777", "7777", "1777", "a+rwx", "ugo+rwx"].includes(arg);
}

function isBlockDeviceRedirect(words: string[]): boolean {
	for (let i = 0; i < words.length - 1; i++) {
		if (words[i] === ">" && /^\/dev\/(sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d+n\d+|mmcblk\d+)/.test(words[i + 1])) {
			return true;
		}
	}
	return false;
}

function looksLikeForkBomb(command: string): boolean {
	return /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*}\s*;\s*:/.test(command) || command.includes(":(){ :|:& };:");
}

function commandBasename(command: string): string {
	return command.split(/[\\/]/).pop()?.toLowerCase() ?? command.toLowerCase();
}

function isAssignment(word: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word);
}

function addMatch(matches: DangerousMatch[], match: DangerousMatch) {
	if (!matches.some((existing) => existing.id === match.id)) matches.push(match);
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function formatReasons(matches: DangerousMatch[]): string {
	return unique(matches.map((match) => match.reason)).slice(0, 2).join(" ");
}

function truncateCommand(command: string): string {
	if (command.length <= MAX_COMMAND_CHARS) return command;
	return `${command.slice(0, MAX_COMMAND_CHARS)}\n...[command truncated]`;
}

function indent(text: string): string {
	return text.split(/\r?\n/).map((line) => `  ${line}`).join("\n");
}
