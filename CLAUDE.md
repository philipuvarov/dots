# CLAUDE.md - Repository Context

## Overview

This is a **personal dotfiles repository** for managing development environment configurations across Fedora Linux systems. The repository provides automated setup scripts and version-controlled configuration files for a complete development environment.

**Target OS**: Fedora Linux
**Setup Command**: `uv run fedora_setup.py` (from the `setup/` directory)

## Repository Structure

```
dots/
├── kitty/              # Kitty terminal emulator configuration
│   └── kitty.conf      # Main terminal config (2,941 lines)
├── zsh/                # Zsh shell configuration
│   └── .zshrc          # Shell config with oh-my-zsh, vim keybindings
├── starship/           # Starship prompt configuration
│   └── starship.toml   # Custom prompt styling (purple/red/green theme)
├── xremap/             # Keyboard remapping configuration
│   └── config.yml      # Key remapping (CapsLock→Ctrl, Alt↔Super)
└── setup/              # Setup automation scripts
    ├── fedora_setup.py # Main setup script (365 lines)
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

### Keyboard (xremap/config.yml)
- Global modmap: CapsLock → Ctrl_L, Alt_L ↔ Super_L
- Contains commented-out keymaps for various applications
- Runs as systemd service (requires input group membership)

## Setup Script (setup/fedora_setup.py)

### Usage
```bash
cd setup/
uv run fedora_setup.py          # Full setup
uv run fedora_setup.py --dry-run # Preview without executing
```

### Installation Steps (in order)
1. RPM Fusion repositories (free media packages)
2. COPR repositories (xremap, lazygit)
3. DNF packages: neovim, kitty, zsh, lazygit, steam, telegram-desktop, luarocks, fzf
4. COPR packages: xremap
5. Flatpak packages: Bitwarden, Discord
6. uv (Python package manager)
7. Git configuration (email, username)
8. SSH key generation (Ed25519 for GitHub)
9. Dotfiles symlinks to ~/.config/
10. xremap systemd service setup
11. Nerd Fonts (IBMPlexMono, ZedMono)
12. GNOME keybinding cleanup (disables Super+N)
13. Default shell change to zsh
14. Starship prompt installation
15. Oh-My-Zsh with plugins

### Symlink Strategy
The script creates these symlinks:
- `kitty/` → `~/.config/kitty/`
- `xremap/` → `~/.config/xremap/`
- `zsh/.zshrc` → `~/.zshrc`
- `starship/starship.toml` → `~/.config/starship.toml`

### Post-Setup Requirements
- **Reboot required** for xremap (input group) and shell change
- **Manual steps**:
  - Upload SSH key to GitHub (`cat ~/.ssh/id_ed25519.pub`)
  - Select Nerd Font in terminal
  - Optional: Install nvim plugins (references kickstart.nvim)

### Key Features
- **Idempotent**: Checks existence before creating files/directories
- **Safe**: Dry-run mode available, existence checks prevent overwrites
- **Modern**: Uses subprocess with proper error handling
- **Service-oriented**: Enables (not starts) xremap service for post-reboot

## Development Environment Focus

The owner's environment emphasizes:
- **Keyboard efficiency**: Vim keybindings everywhere, custom key remapping
- **Modern tooling**: Neovim, lazygit, starship, xremap
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
- **Adding new config**: Create directory, add config file, update fedora_setup.py symlinks
- **Adding new distro**: Create new setup script (e.g., `ubuntu_setup.py`) in setup/
- **Modifying setup**: Edit fedora_setup.py, test with --dry-run first
- **Config changes**: Edit files directly (kitty.conf, .zshrc, etc.)

### Important Notes
- Always test setup script changes with `--dry-run` first
- Symlinks mean config changes are immediate (no re-linking needed)
- xremap requires input group membership (needs reboot)
- The repository references external dependency: kickstart.nvim for neovim config

### File Locations After Setup
- Configs live in this repo, symlinked to standard XDG locations
- Changes to repo files immediately affect active system
- Use `git status` to track which configs have been modified

## External Dependencies
- **Neovim config**: References kickstart.nvim repository (not included here)
- **Oh-My-Zsh**: Installed by setup script to `~/.oh-my-zsh`
- **Starship**: Binary installed to system, config in this repo
