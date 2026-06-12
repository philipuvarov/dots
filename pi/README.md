# Pi dotfiles

Safe global Pi config for `~/.pi/agent`.

Included:
- `settings.json`
- `extensions/`
- optional `keybindings.json`, `AGENTS.md`, `models.json`
- optional `skills/`, `prompts/`, `themes/`

If adding `models.json`, use environment variables or commands for API keys, not literal secrets.

Excluded private/runtime files:
- `auth.json`
- `trust.json`
- `sessions/`
- `bin/`, `npm/`, `node_modules/`
