# CLAUDE.md - Repository Context

## Overview

This is a **personal dotfiles repository** for managing development environment configurations across Linux and macOS. The repository provides automated setup scripts and version-controlled configuration files for a complete development environment.

**Supported Platforms**: Fedora Linux, Arch Linux, macOS
**Setup Commands** (from the `setup/` directory):
- Fedora: `uv run fedora_setup.py`
- Arch: `uv run arch_setup.py`
- macOS: `uv run mac_setup.py`

## Repository Structure

```
dots/
├── kitty/              # Kitty terminal emulator configuration
│   └── kitty.conf      # Main terminal config (2,941 lines)
├── ghostty/            # Ghostty terminal emulator configuration
│   └── config.ghostty  # Oxocarbon theme and Herdr navigation bindings
├── herdr/              # Herdr agent multiplexer configuration
│   └── config.toml     # Keys, UI, notifications, and terminal theme
├── zsh/                # Zsh shell configuration
│   └── .zshrc          # Shell config with oh-my-zsh, vim keybindings
├── starship/           # Starship prompt configuration
│   └── starship.toml   # Custom prompt styling (purple/red/green theme)
├── keyd/               # Keyboard remapping configuration
│   └── default.conf    # Key remapping (CapsLock→Ctrl, Alt↔Super)
├── pi/                 # Safe Pi coding agent config (no auth/sessions)
│   ├── settings.json   # Global Pi settings
│   ├── extensions/     # Local Pi extensions, including Herdr integration
│   └── local-packages/ # Repo-owned Pi packages and theme pack
└── setup/              # Setup automation scripts
    ├── packages.py     # Shared package definitions across platforms
    ├── fedora_setup.py # Fedora setup script
    ├── arch_setup.py   # Arch Linux setup script
    ├── mac_setup.py    # macOS setup script
    ├── pyproject.toml  # Python project metadata
    └── .python-version # Python 3.14
```

## Configuration Files

### Shell (zsh/.zshrc)
- Oh-My-Zsh framework
- Starship prompt integration
- Vim keybindings (`bindkey -v`)
- Plugins: git, colorize, fzf, zsh-syntax-highlighting, zsh-autosuggestions
- Sources environment from `~/.local/bin/env`

### Terminals

#### Kitty (kitty/kitty.conf)
- Comprehensive configuration with the Aura theme
- Font settings, color schemes, keyboard shortcuts
- Window/tab management, copy/paste behavior

#### Ghostty (ghostty/config.ghostty)
- BlexMono Nerd Font Mono with the built-in Oxocarbon theme
- Minimal macOS chrome and Kitty-compatible clipboard behavior
- Super+arrow escape-sequence bindings for cycling Herdr tabs and workspaces

### Herdr (herdr/config.toml)
- Agent-aware terminal multiplexer using terminal-native colors
- Custom tab/workspace keys, hidden collapsed sidebar, and in-app notifications
- Runtime logs, sockets, and session state stay outside the repository

### Prompt (starship/starship.toml)
- Custom format: `[username@hostname] directory git-info`
- Color-coded status (purple=success, red=error, green=vim mode)
- Right-aligned time display (HH:MM)
- Git branch/status visualization, command duration

### Keyboard (keyd/default.conf)
- Global remapping: CapsLock → Ctrl, Alt ↔ Super
- Runs as system service (keyd)
- Config copied to /etc/keyd/default.conf by setup script

### Pi (pi/)
- Safe global Pi config for `~/.pi/agent`
- Includes `settings.json`, extension sources, placeholder resource dirs, and local packages
- `local-packages/pi-theme-pack` provides Aura, Cyberdream, Oxocarbon, and Tokyo Night
- Includes Herdr's managed Pi lifecycle/session integration
- Excludes private/runtime files: `auth.json`, `trust.json`, `sessions/`, `bin/`, `npm/`, `node_modules/`

## Setup Scripts

### Shared Configuration (packages.py)
Common definitions used by the setup scripts:
- **COMMON_PACKAGES**: neovim, kitty, ghostty, zsh, lazygit, luarocks, fzf, telegram-desktop, steam, keyd
- **HOMEBREW_FORMULAE** includes Herdr; **HOMEBREW_CASKS** includes Ghostty and Kitty
- **NERD_FONTS**: IBMPlexMono, ZedMono
- **GIT_CONFIG**: user.email, user.name

### Fedora Setup (fedora_setup.py)
```bash
cd setup/
uv run fedora_setup.py          # Full setup
uv run fedora_setup.py --dry-run # Preview without executing
```

**Installation Steps:**
1. RPM Fusion repositories (free media packages)
2. COPR repositories (lazygit, keyd, Ghostty)
3. DNF packages (from COMMON_PACKAGES, includes Ghostty and keyd)
4. Flatpak packages: Bitwarden, Discord
5. uv, Herdr, git config, SSH key, dotfiles, keyd setup
6. Nerd Fonts, GNOME keybindings, zsh, Starship, Oh-My-Zsh

### Arch Setup (arch_setup.py)
```bash
cd setup/
uv run arch_setup.py          # Full setup
uv run arch_setup.py --dry-run # Preview without executing
```

**Requirements**: yay (AUR helper) must be installed first

**Installation Steps:**
1. Pacman packages (from COMMON_PACKAGES, includes Ghostty and keyd)
2. AUR packages: bitwarden, discord, herdr-bin
3. uv, git config, SSH key, dotfiles, keyd setup
4. Nerd Fonts, GNOME keybindings, zsh, Starship, Oh-My-Zsh

### macOS Setup (mac_setup.py)
- Installs Homebrew formulae/casks, including Herdr, Ghostty, and Kitty
- Links macOS's Ghostty Application Support config plus shared Herdr/Pi/shell configs
- Installs Nerd Fonts, Starship, Oh-My-Zsh, and plugins

### Symlink Strategy
The script creates these symlinks:
- `kitty/` → `~/.config/kitty/`
- `ghostty/config.ghostty` → `~/.config/ghostty/config.ghostty` on Linux or Ghostty's Application Support directory on macOS
- `herdr/config.toml` → `~/.config/herdr/config.toml` (only the static config; runtime state remains local)
- `zsh/.zshrc` → `~/.zshrc`
- `starship/starship.toml` → `~/.config/starship.toml`
- `pi/settings.json` → `~/.pi/agent/settings.json`
- `pi/{skills,prompts,themes,extensions,local-packages}` → `~/.pi/agent/{skills,prompts,themes,extensions,local-packages}`
- Optional Pi files when present: `keybindings.json`, `AGENTS.md`, `models.json`

Note: keyd config is copied (not symlinked) to `/etc/keyd/default.conf`

### Post-Setup Requirements
- **Reboot required** for shell change to zsh
- **Manual steps**:
  - Upload SSH key to GitHub (`cat ~/.ssh/id_ed25519.pub`)
  - Select Nerd Font in terminal
  - Optional: Install nvim plugins (references kickstart.nvim)

### Key Features
- **Idempotent**: Checks existence before creating files/directories
- **Safe**: Dry-run mode available, existence checks prevent overwrites
- **Modern**: Uses subprocess with proper error handling
- **Service-oriented**: keyd starts immediately, enabled for boot

## Development Environment Focus

The owner's environment emphasizes:
- **Keyboard efficiency**: Vim keybindings everywhere, custom key remapping
- **Modern tooling**: Neovim, lazygit, starship, keyd, Herdr
- **Terminal-centric workflow**: Ghostty and Kitty terminals, Herdr multiplexer, zsh shell
- **Git integration**: Built-in SSH key setup, git configuration
- **Python development**: Python 3.14, uv package manager

## Git Workflow

Recent commits show active development:
- `6d39b27` - clean up
- `a22da51` - wip
- `a17d854` - starship
- `6682fd3` - add setup script and configs (major addition)

Main branch: `main`

## When Helping With This Repository

### Common Tasks
- **Adding new config**: Create directory, add config file, update setup scripts' symlinks
- **Adding new distro**: Create new setup script in setup/, import from packages.py
- **Adding shared packages**: Edit packages.py COMMON_PACKAGES list
- **Modifying setup**: Edit the relevant setup script, test with --dry-run first
- **Config changes**: Edit files directly (kitty.conf, .zshrc, etc.)

### Important Notes
- Always test setup script changes with `--dry-run` first
- Symlinks mean config changes are immediate (no re-linking needed)
- keyd config changes require re-running setup or manually copying to /etc/keyd/
- The repository references external dependency: kickstart.nvim for neovim config

### File Locations After Setup
- Configs live in this repo, symlinked to standard XDG locations
- Changes to repo files immediately affect active system
- Use `git status` to track which configs have been modified

## External Dependencies
- **Neovim config**: References kickstart.nvim repository (not included here)
- **Oh-My-Zsh**: Installed by setup script to `~/.oh-my-zsh`
- **Starship**: Binary installed to system, config in this repo
