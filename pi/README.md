# Pi dotfiles

Safe global Pi config for `~/.pi/agent`.

Included:
- `settings.json`
- `AGENTS.md` with global response-style instructions
- `extensions/` (including the Herdr agent-state integration)
- `local-packages/pi-theme-pack/` with Aura, Cyberdream, Oxocarbon, and Tokyo Night
- optional `keybindings.json`, `models.json`
- optional `skills/`, `prompts/`, `themes/`

If adding `models.json`, use environment variables or commands for API keys, not literal secrets.

Excluded private/runtime files:
- `auth.json`
- `trust.json`
- `sessions/`
- `bin/`, `npm/`, `node_modules/`
