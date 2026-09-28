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

Neovim defaults to `https://github.com/philipuvarov/kickstart.nvim.git`.
Set `DOTS_NVIM_REPO` to override it. The fork tracks `lazy-lock.json` to
preserve plugin versions; run `:Lazy restore` to restore those versions.

Btop is installed on all supported platforms, with `btop/` linked to
`~/.config/btop/`.

Before retiring a machine, transfer secrets separately (never through Git):
`~/.zshrc.local`, any SSH/GPG keys you intend to retain, and credentials you
cannot recreate by signing in again. Git identity is supplied through
`DOTS_GIT_NAME` and `DOTS_GIT_EMAIL`. Locally installed agent skills, session
history, browser profiles, and other unmanaged app settings are not backed
up by this repository.

## Reapply configuration

```bash
cd setup
uv run configure.py
```

Configure reapplies packages, dotfile links, Pi links, copied system configs,
services, Git settings, and desktop preferences. It does not rerun remote tool
installers, download fonts, generate SSH keys, or clone repositories.

## Arch / Hyprland screenshots

The Arch setup installs Hyprshot and its capture/clipboard dependencies.

| Shortcut | Capture |
| --- | --- |
| `Print` | Select a region |
| `Shift+Print` | Select a window |
| `Super+Print` | Select a monitor |
| `Super+Shift+P` | Select a region (without a Print Screen key) |

Captures are saved to `~/Pictures/Screenshots` (created automatically) and
copied to the clipboard. Press `Esc` to cancel selection.

On an already configured machine, install just the new tool with
`sudo pacman -S --needed hyprshot`. The linked Hyprland config reloads
automatically; use `hyprctl reload` if needed.

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
