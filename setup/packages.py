"""
Shared package definitions and configuration for setup scripts.

This module contains shared configuration used by the Fedora, Arch, and macOS
setup scripts to avoid duplication.
"""

import os

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

FEDORA_PACKAGES = [
    *COMMON_PACKAGES,
    "ghostty",
]

ARCH_PACMAN_PACKAGES = [
    *COMMON_PACKAGES,
    "hyprland",
    "hyprpaper",
    "hyprlock",
    "hypridle",
    "waybar",
    "ly",
    "gnome-shell",
    "firefox",
    "btop",
    "nautilus",
    "network-manager-applet",
    "pipewire",
    "wireplumber",
    "brightnessctl",
    "playerctl",
    "xdg-desktop-portal-hyprland",
    "xdg-desktop-portal-gtk",
    "wl-clipboard",
]

# Fedora: Flatpak packages
FEDORA_FLATPAK_PACKAGES = [
    "com.bitwarden.desktop",
    "com.discordapp.Discord",
]

# Arch: Additional packages from official repos or AUR
ARCH_EXTRA_PACKAGES = [
    "herdr-bin",
    "tofi",
]

# macOS: Homebrew packages. Linux-only keyd/GNOME behavior is intentionally
# handled by the Linux scripts; Telegram, Discord, and Bitwarden are skipped.
HOMEBREW_FORMULAE = [
    "fd",
    "go",
    "herdr",
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
    "ghostty",
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

_GIT_EMAIL = os.environ.get("DOTS_GIT_EMAIL")
_GIT_NAME = os.environ.get("DOTS_GIT_NAME")

GIT_CONFIG = {
    key: value
    for key, value in {
        "user.email": _GIT_EMAIL,
        "user.name": _GIT_NAME,
    }.items()
    if value
}

# =============================================================================
# Dotfile Repositories
# =============================================================================

DOTFILE_REPOS = {
    "nvim": os.environ.get("DOTS_NVIM_REPO", "https://github.com/nvim-lua/kickstart.nvim.git"),
    "dots": os.environ.get("DOTS_REPO", ""),
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
    "local-packages",
]

# =============================================================================
# GNOME Keybindings to Disable
# =============================================================================

GNOME_KEYBINDINGS_TO_DISABLE = [
    f"org.gnome.shell.keybindings switch-to-application-{i}" for i in range(1, 10)
]
