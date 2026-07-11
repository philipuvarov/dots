import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const themeNames = ["oxocarbon", "cyberdream", "aura", "tokyo-night"] as const;
type ThemeName = (typeof themeNames)[number];

function isThemeName(value: string): value is ThemeName {
  return themeNames.includes(value as ThemeName);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("theme-pack", {
    description: "Switch themes from the local theme pack",
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const items = themeNames
        .filter((name) => name.startsWith(prefix.trim().toLowerCase()))
        .map((name) => ({ value: name, label: name }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      let selected = args.trim().toLowerCase();

      if (!isThemeName(selected)) {
        if (!ctx.hasUI) {
          ctx.ui.notify(`Usage: /theme-pack ${themeNames.join("|")}`, "warning");
          return;
        }

        const choice = await ctx.ui.select("Choose a pi theme", [
          "Oxocarbon",
          "Cyberdream",
          "Aura",
          "Tokyo Night",
        ]);
        if (!choice) return;
        selected = choice.toLowerCase().replaceAll(" ", "-");
      }

      const result = ctx.ui.setTheme(selected);
      if (result.success) {
        ctx.ui.notify(`Theme set to ${selected}`, "info");
      } else {
        ctx.ui.notify(result.error ?? `Could not load ${selected}`, "error");
      }
    },
  });
}
