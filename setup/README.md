# Machine setup

The scripts have two entry points:

- `bootstrap.py` prepares a new machine and then applies its configuration.
- `configure.py` reapplies the managed state on an existing machine.

Both commands detect Arch Linux, Fedora, or macOS automatically.

## Bootstrap a new machine

```bash
cd setup
uv run bootstrap.py
```

Bootstrap installs the managed packages and configuration, then performs the
one-time setup: tool installers, SSH key generation, Neovim config cloning,
fonts, Oh My Zsh, Starship, and the default shell.

## Reapply configuration

```bash
cd setup
uv run configure.py
```

Configure reapplies packages, dotfile links, Pi links, copied system configs,
services, Git settings, and desktop preferences. It does not rerun remote tool
installers, download fonts, generate SSH keys, or clone repositories.

## Options

Preview either command without making changes:

```bash
uv run configure.py --dry-run
uv run bootstrap.py --dry-run
```

Platform detection can be overridden when needed:

```bash
uv run configure.py --platform arch
uv run bootstrap.py --platform fedora
uv run bootstrap.py --platform macos
```

The platform-specific `arch_setup.py`, `fedora_setup.py`, and `mac_setup.py`
modules contain the implementation and can still be run directly for
compatibility. Running one directly performs a bootstrap.
