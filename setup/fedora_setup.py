#!/usr/bin/env python3
"""
Fedora Desktop Environment Setup Script

Recreates a development environment based on captured setup history.
Run with: python3 fedora_setup.py [--dry-run]
"""
from __future__ import annotations

import subprocess
import os
import sys
from pathlib import Path

from packages import (
    COMMON_PACKAGES,
    FEDORA_FLATPAK_PACKAGES,
    NERD_FONTS,
    GIT_CONFIG,
    DOTFILE_REPOS,
    GNOME_KEYBINDINGS_TO_DISABLE,
    PI_SAFE_DIRS,
    PI_SAFE_FILES,
)

DRY_RUN = "--dry-run" in sys.argv
DOTS_DIR = Path(__file__).resolve().parents[1]

# =============================================================================
# Fedora-Specific Configuration
# =============================================================================

COPR_REPOS = [
    "dejan/lazygit",
    "alternateved/keyd",
    "scottames/ghostty",
]

RPMFUSION_FREE_URL = (
    "https://download1.rpmfusion.org/free/fedora/"
    "rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm"
)

# =============================================================================
# Helpers
# =============================================================================


def run(
    cmd: str | list[str], shell: bool = False, check: bool = True
) -> subprocess.CompletedProcess:
    """Run a command, respecting DRY_RUN mode."""
    if isinstance(cmd, list):
        display_cmd = " ".join(cmd)
    else:
        display_cmd = cmd

    if DRY_RUN:
        print(f"[DRY RUN] {display_cmd}")
        return subprocess.CompletedProcess(cmd, 0)

    print(f"[RUN] {display_cmd}")
    return subprocess.run(cmd, shell=shell, check=check)


def section(title: str):
    """Print a section header."""
    print(f"\n{'=' * 60}\n{title}\n{'=' * 60}")


def prompt_remove_if_exists(path: Path) -> bool:
    """Prompt user to remove existing file/directory if it exists.

    Returns True if path was removed or doesn't exist, False otherwise.
    """
    if not path.exists() and not path.is_symlink():
        return True

    if DRY_RUN:
        print(f"[DRY RUN] Would prompt to remove existing: {path}")
        return True

    response = input(f"\n{path} already exists. Remove it? (y/n): ").strip().lower()
    if response in ("y", "yes"):
        if path.is_dir() and not path.is_symlink():
            run(["rm", "-rf", str(path)])
        else:
            run(["rm", "-f", str(path)])
        print(f"Removed {path}")
        return True
    else:
        print(f"Skipping {path}")
        return False


def symlink_path(src: Path, dst: Path):
    """Symlink src to dst if src exists."""
    if not src.exists():
        return

    if dst.is_symlink() and dst.resolve() == src.resolve():
        print(f"{dst} already linked, skipping")
        return

    if prompt_remove_if_exists(dst):
        run(["ln", "-s", str(src), str(dst)])


# =============================================================================
# Setup Steps
# =============================================================================


def install_rpmfusion():
    section("Installing RPM Fusion (free)")
    # Need shell=True for the $(rpm -E %fedora) expansion
    run(f"sudo dnf install -y {RPMFUSION_FREE_URL}", shell=True)


def enable_copr_repos():
    section("Enabling COPR repositories")
    for repo in COPR_REPOS:
        run(["sudo", "dnf", "copr", "enable", "-y", repo])


def install_dnf_packages():
    section("Installing DNF packages")
    run(["sudo", "dnf", "install", "-y"] + COMMON_PACKAGES)


def install_flatpak_packages():
    section("Installing Flatpak packages")
    for pkg in FEDORA_FLATPAK_PACKAGES:
        run(["flatpak", "install", "-y", "flathub", pkg])


def install_uv():
    section("Installing uv (Python package manager)")
    run("curl -LsSf https://astral.sh/uv/install.sh | sh", shell=True)


def install_herdr():
    section("Installing Herdr")
    run("curl -fsSL https://herdr.dev/install.sh | sh", shell=True)


def setup_git_config():
    section("Configuring Git")
    for key, value in GIT_CONFIG.items():
        run(["git", "config", "--global", key, value])


def generate_ssh_key():
    section("Generating SSH key")
    ssh_key_path = Path.home() / ".ssh" / "id_ed25519"
    if ssh_key_path.exists():
        print(f"SSH key already exists at {ssh_key_path}, skipping")
        return

    email = GIT_CONFIG.get("user.email", "")
    run(["ssh-keygen", "-t", "ed25519", "-C", email, "-N", "", "-f", str(ssh_key_path)])
    print(f"\nPublic key ({ssh_key_path}.pub):")
    if not DRY_RUN:
        print(ssh_key_path.with_suffix(".pub").read_text())


def setup_dotfiles():
    section("Setting up dotfiles")
    config_dir = Path.home() / ".config"
    config_dir.mkdir(exist_ok=True)

    # Clone neovim config
    nvim_dir = config_dir / "nvim"
    if nvim_dir.exists():
        print(f"{nvim_dir} already exists, skipping")
    else:
        run(["git", "clone", DOTFILE_REPOS["nvim"], str(nvim_dir)])

    # Symlink terminal configs
    symlink_path(DOTS_DIR / "kitty", config_dir / "kitty")

    ghostty_config_dir = config_dir / "ghostty"
    herdr_config_dir = config_dir / "herdr"
    if DRY_RUN:
        print(f"[DRY RUN] mkdir -p {ghostty_config_dir}")
        print(f"[DRY RUN] mkdir -p {herdr_config_dir}")
    else:
        ghostty_config_dir.mkdir(parents=True, exist_ok=True)
        herdr_config_dir.mkdir(parents=True, exist_ok=True)

    symlink_path(
        DOTS_DIR / "ghostty" / "config.ghostty",
        ghostty_config_dir / "config.ghostty",
    )
    symlink_path(
        DOTS_DIR / "herdr" / "config.toml",
        herdr_config_dir / "config.toml",
    )

    # Symlink starship config
    symlink_path(DOTS_DIR / "starship" / "starship.toml", config_dir / "starship.toml")


def setup_pi():
    section("Setting up Pi")
    pi_src = DOTS_DIR / "pi"
    pi_agent_dir = Path.home() / ".pi" / "agent"

    if not pi_src.exists():
        print(f"{pi_src} not found, skipping")
        return

    if DRY_RUN:
        print(f"[DRY RUN] mkdir -p {pi_agent_dir}")
    else:
        pi_agent_dir.mkdir(parents=True, exist_ok=True)

    for name in PI_SAFE_FILES:
        symlink_path(pi_src / name, pi_agent_dir / name)

    for name in PI_SAFE_DIRS:
        symlink_path(pi_src / name, pi_agent_dir / name)


def setup_zshrc():
    """Symlink zshrc - must be called AFTER oh-my-zsh and starship are installed."""
    section("Setting up zshrc")
    symlink_path(DOTS_DIR / "zsh" / ".zshrc", Path.home() / ".zshrc")


def setup_keyd():
    section("Setting up keyd")
    keyd_src = DOTS_DIR / "keyd" / "default.conf"

    # Copy keyd config to system location
    run(["sudo", "mkdir", "-p", "/etc/keyd"])
    run(["sudo", "cp", str(keyd_src), "/etc/keyd/default.conf"])

    # Enable and start keyd service
    run(["sudo", "systemctl", "enable", "keyd"])
    run(["sudo", "systemctl", "start", "keyd"])


def install_nerd_fonts():
    section("Installing Nerd Fonts")
    fonts_dir = Path.home() / ".local" / "share" / "fonts"
    fonts_dir.mkdir(parents=True, exist_ok=True)

    tmp_dir = Path("/tmp/nerd-fonts")
    if not DRY_RUN:
        tmp_dir.mkdir(exist_ok=True)

    for url in NERD_FONTS:
        font_name = url.split("/")[-1].replace(".zip", "")
        zip_path = tmp_dir / f"{font_name}.zip"
        extract_dir = tmp_dir / font_name

        run(["curl", "-L", "-o", str(zip_path), url])
        run(["unzip", "-o", str(zip_path), "-d", str(extract_dir)])

        # Copy only .ttf files (skip Windows-compatible .otf and license files)
        if not DRY_RUN:
            for ttf in extract_dir.glob("*.ttf"):
                run(["cp", str(ttf), str(fonts_dir)])

    # run(["fc-cache", "-fv"])


def disable_gnome_super_keybindings():
    section("Disabling GNOME Super+N keybindings")
    for binding in GNOME_KEYBINDINGS_TO_DISABLE:
        schema, key = binding.rsplit(" ", 1)
        run(["gsettings", "set", schema, key, "[]"])


def change_shell_to_zsh():
    section("Changing default shell to zsh")
    zsh_path = "/usr/bin/zsh"
    run(["sudo", "chsh", "-s", zsh_path, os.environ["USER"]])


def install_starship_prompt():
    section("Installing Starship prompt")
    # run("curl -sS https://starship.rs/install.sh | sh -- -y", shell=True)
    run(
        [
            "curl",
            "-sS",
            "https://starship.rs/install.sh",
            "-o",
            "/tmp/install_starship.sh",
        ]
    )
    run(["sh", "/tmp/install_starship.sh", "-y"])


def install_omzsh_and_plugins():
    section("Installing oh my zsh")
    omz_dir = Path.home() / ".oh-my-zsh"
    if omz_dir.exists():
        print(f"{omz_dir} already exists, skipping oh-my-zsh installation")
    else:
        run(
            'sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended',
            shell=True,
        )

    # Install plugins
    custom_plugins = Path.home() / ".oh-my-zsh" / "custom" / "plugins"

    syntax_hl = custom_plugins / "zsh-syntax-highlighting"
    if not syntax_hl.exists():
        run(
            [
                "git",
                "clone",
                "https://github.com/zsh-users/zsh-syntax-highlighting.git",
                str(syntax_hl),
            ]
        )

    autosuggestions = custom_plugins / "zsh-autosuggestions"
    if not autosuggestions.exists():
        run(
            [
                "git",
                "clone",
                "https://github.com/zsh-users/zsh-autosuggestions.git",
                str(autosuggestions),
            ]
        )


def print_post_install_notes():
    section("Post-installation notes")
    print("""
1. REBOOT REQUIRED for zsh as default shell

2. Add your SSH public key to GitHub:
   cat ~/.ssh/id_ed25519.pub

3. Run 'nvim' to trigger lazy.nvim plugin installation.

4. Check keyd is running:
   sudo systemctl status keyd

5. Ghostty is configured with BlexMono Nerd Font and the Oxocarbon theme.

6. Launch `herdr` to create or attach to its persistent terminal session.
""")


# =============================================================================
# Main
# =============================================================================


def main():
    if DRY_RUN:
        print("*** DRY RUN MODE - No changes will be made ***\n")

    install_rpmfusion()
    enable_copr_repos()
    install_dnf_packages()
    install_flatpak_packages()
    install_uv()
    install_herdr()
    setup_git_config()
    generate_ssh_key()
    setup_dotfiles()
    setup_pi()
    setup_keyd()
    install_nerd_fonts()
    disable_gnome_super_keybindings()
    install_starship_prompt()
    install_omzsh_and_plugins()
    setup_zshrc()
    change_shell_to_zsh()
    print_post_install_notes()

    print("\n Setup complete! Please reboot.")


if __name__ == "__main__":
    main()
