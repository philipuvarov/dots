import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

let unsubscribe: (() => void) | undefined;

export default function ctrlCInterrupt(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		unsubscribe?.();
		unsubscribe = undefined;

		if (ctx.mode !== "tui") return;

		unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, "ctrl+c")) return undefined;

			// Preserve pi's normal Ctrl+C behavior when idle:
			// - clear editor
			// - double Ctrl+C exits
			// Only consume Ctrl+C while the agent is actively running.
			if (ctx.isIdle()) return undefined;

			ctx.abort();
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
	});
}
