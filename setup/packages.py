"""
Shared package definitions and configuration for setup scripts.

This module contains common configuration used by both fedora_setup.py
and arch_setup.py to avoid duplication.
"""

# =============================================================================
# Common Packages (available in both distros under same/similar names)
# =============================================================================

COMMON_PACKAGES = [
    "neovim",
    "kitty",
    "zsh",
    "lazygit",
    "luarocks",
    "fzf",
    "telegram-desktop",
    "steam",
    "keyd",
]

# =============================================================================
# Distro-Specific Packages
# =============================================================================

# Fedora: Flatpak packages
FEDORA_FLATPAK_PACKAGES = [
    "com.bitwarden.desktop",
    "com.discordapp.Discord",
]

# Arch: Additional packages from official repos or AUR
ARCH_EXTRA_PACKAGES = [
    "bitwarden",
    "discord",
]

# macOS: Homebrew packages. Linux-only keyd/GNOME behavior is intentionally
# handled by the Linux scripts; Telegram, Discord, and Bitwarden are skipped.
HOMEBREW_FORMULAE = [
    "fd",
    "go",
    "hunspell",
    "neovim",
    "pkgconf",
    "ripgrep",
    "tree-sitter-cli",
    "zsh",
    "lazygit",
    "luarocks",
    "fzf",
]

HOMEBREW_CASKS = [
    "kitty",
    "steam",
]

# =============================================================================
# Nerd Fonts
# =============================================================================

NERD_FONTS = [
    "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/IBMPlexMono.zip",
    "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/ZedMono.zip",
]

# =============================================================================
# Git Configuration
# =============================================================================

GIT_CONFIG = {
    "user.email": "user@example.invalid",
    "user.name": "dotfiles-user",
}

# =============================================================================
# Dotfile Repositories
# =============================================================================

DOTFILE_REPOS = {
    "nvim": "git@github.com:dotfiles-user/kickstart.nvim.git",
    "dots": "git@github.com:dotfiles-user/dots.git",
}

# =============================================================================
# Pi Configuration
# =============================================================================

# Do not add Pi private/runtime state here (auth.json, trust.json, sessions, bin, npm).
PI_SAFE_FILES = [
    "settings.json",
    "keybindings.json",
    "AGENTS.md",
    "models.json",
]

PI_SAFE_DIRS = [
    "skills",
    "prompts",
    "themes",
    "extensions",
]

# =============================================================================
# GNOME Keybindings to Disable
# =============================================================================

GNOME_KEYBINDINGS_TO_DISABLE = [
    f"org.gnome.shell.keybindings switch-to-application-{i}" for i in range(1, 10)
]
