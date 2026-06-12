# CLAUDE.md - Repository Context

## Overview

This is a **personal dotfiles repository** for managing development environment configurations across Linux systems. The repository provides automated setup scripts and version-controlled configuration files for a complete development environment.

**Supported Distros**: Fedora Linux, Arch Linux
**Setup Commands** (from the `setup/` directory):
- Fedora: `uv run fedora_setup.py`
- Arch: `uv run arch_setup.py`

## Repository Structure

```
dots/
├── kitty/              # Kitty terminal emulator configuration
│   └── kitty.conf      # Main terminal config (2,941 lines)
├── zsh/                # Zsh shell configuration
│   └── .zshrc          # Shell config with oh-my-zsh, vim keybindings
├── starship/           # Starship prompt configuration
│   └── starship.toml   # Custom prompt styling (purple/red/green theme)
├── keyd/               # Keyboard remapping configuration
│   └── default.conf    # Key remapping (CapsLock→Ctrl, Alt↔Super)
├── pi/                 # Safe Pi coding agent config (no auth/sessions)
│   ├── settings.json   # Global Pi settings
│   └── extensions/     # Local Pi extensions
└── setup/              # Setup automation scripts
    ├── packages.py     # Shared package definitions across distros
    ├── fedora_setup.py # Fedora setup script
    ├── arch_setup.py   # Arch Linux setup script
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

### Terminal (kitty/kitty.conf)
- Comprehensive 2,941-line configuration
- Font settings, color schemes, keyboard shortcuts
- Window/tab management, copy/paste behavior

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
- Includes `settings.json`, extension sources, and placeholder resource dirs
- Excludes private/runtime files: `auth.json`, `trust.json`, `sessions/`, `bin/`, `npm/`, `node_modules/`

## Setup Scripts

### Shared Configuration (packages.py)
Common definitions used by both setup scripts:
- **COMMON_PACKAGES**: neovim, kitty, zsh, lazygit, luarocks, fzf, telegram-desktop, steam, keyd
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
2. COPR repositories (lazygit, keyd)
3. DNF packages (from COMMON_PACKAGES, includes keyd)
4. Flatpak packages: Bitwarden, Discord
5. uv, git config, SSH key, dotfiles, keyd setup
6. Nerd Fonts, GNOME keybindings, zsh, Starship, Oh-My-Zsh

### Arch Setup (arch_setup.py)
```bash
cd setup/
uv run arch_setup.py          # Full setup
uv run arch_setup.py --dry-run # Preview without executing
```

**Requirements**: yay (AUR helper) must be installed first

**Installation Steps:**
1. Pacman packages (from COMMON_PACKAGES, includes keyd)
2. AUR packages: bitwarden, discord
3. uv, git config, SSH key, dotfiles, keyd setup
4. Nerd Fonts, GNOME keybindings, zsh, Starship, Oh-My-Zsh

### Symlink Strategy
The script creates these symlinks:
- `kitty/` → `~/.config/kitty/`
- `zsh/.zshrc` → `~/.zshrc`
- `starship/starship.toml` → `~/.config/starship.toml`
- `pi/settings.json` → `~/.pi/agent/settings.json`
- `pi/{skills,prompts,themes,extensions}` → `~/.pi/agent/{skills,prompts,themes,extensions}`
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
- **Modern tooling**: Neovim, lazygit, starship, keyd
- **Terminal-centric workflow**: Kitty terminal, zsh shell
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
