#!/usr/bin/env python3
"""
Arch Linux Desktop Environment Setup Script

Recreates a development environment based on captured setup history.
Run with: python3 arch_setup.py [--dry-run]

Requires: yay (AUR helper) - install manually first if not present
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from packages import (
    ARCH_PACMAN_PACKAGES,
    ARCH_EXTRA_PACKAGES,
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


def check_yay():
    """Check if yay is installed, offer to install if not."""
    if DRY_RUN:
        print("[DRY RUN] which yay")
        return

    result = subprocess.run(["which", "yay"], capture_output=True)
    if result.returncode != 0:
        print("yay (AUR helper) is not installed.")
        print("Install it with:")
        print("  git clone https://aur.archlinux.org/yay.git")
        print("  cd yay && makepkg -si")
        sys.exit(1)


# =============================================================================
# Setup Steps
# =============================================================================


def install_pacman_packages():
    section("Installing pacman packages")
    run(
        ["sudo", "pacman", "-S", "--needed", "--noconfirm"]
        + ARCH_PACMAN_PACKAGES
    )


def install_aur_packages():
    section("Installing AUR packages")
    run(["yay", "-S", "--needed", "--noconfirm"] + ARCH_EXTRA_PACKAGES)


def install_uv():
    section("Installing uv (Python package manager)")
    run("curl -LsSf https://astral.sh/uv/install.sh | sh", shell=True)


def setup_git_config():
    section("Configuring Git")
    for key, value in GIT_CONFIG.items():
        run(["git", "config", "--global", key, value])


def generate_ssh_key():
    section("Generating SSH key")
    ssh_dir = Path.home() / ".ssh"
    ssh_key_path = ssh_dir / "id_ed25519"

    if ssh_key_path.exists():
        print(f"SSH key already exists at {ssh_key_path}, skipping")
        return

    if not DRY_RUN:
        ssh_dir.mkdir(mode=0o700, exist_ok=True)

    email = GIT_CONFIG.get("user.email", "")
    run(
        [
            "ssh-keygen",
            "-t",
            "ed25519",
            "-C",
            email,
            "-N",
            "",
            "-f",
            str(ssh_key_path),
        ]
    )


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

    # Symlink desktop and terminal configs
    symlink_path(DOTS_DIR / "hypr", config_dir / "hypr")
    symlink_path(DOTS_DIR / "kitty", config_dir / "kitty")
    symlink_path(DOTS_DIR / "tofi", config_dir / "tofi")

    wallpaper_dir = Path.home() / "wallpapers" / "aura"
    if DRY_RUN:
        print(f"[DRY RUN] mkdir -p {wallpaper_dir}")
    else:
        wallpaper_dir.mkdir(parents=True, exist_ok=True)
    symlink_path(
        DOTS_DIR / "wallpapers" / "aura" / "1.png",
        wallpaper_dir / "1.png",
    )

    herdr_config_dir = config_dir / "herdr"
    if DRY_RUN:
        print(f"[DRY RUN] mkdir -p {herdr_config_dir}")
    else:
        herdr_config_dir.mkdir(parents=True, exist_ok=True)

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


def setup_gdm():
    section("Enabling GDM greeter")
    run(["sudo", "systemctl", "enable", "gdm.service"])


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

        # Copy only .ttf files
        if not DRY_RUN:
            for ttf in extract_dir.glob("*.ttf"):
                run(["cp", str(ttf), str(fonts_dir)])


def setup_desktop_preferences():
    section("Configuring desktop preferences")
    run(
        [
            "gsettings",
            "set",
            "org.gnome.desktop.interface",
            "color-scheme",
            "prefer-dark",
        ]
    )

    for binding in GNOME_KEYBINDINGS_TO_DISABLE:
        schema, key = binding.rsplit(" ", 1)
        run(["gsettings", "set", schema, key, "[]"])


def change_shell_to_zsh():
    section("Changing default shell to zsh")
    zsh_path = "/usr/bin/zsh"
    run(["chsh", "-s", zsh_path])


def install_starship_prompt():
    section("Installing Starship prompt")
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

5. Kitty uses Cyberdream; Hyprland uses the tracked Aura wallpaper and Tofi config.

6. GDM starts after reboot. Select GNOME or Hyprland from its session menu.

7. Launch `herdr` to create or attach to its persistent terminal session.
""")


# =============================================================================
# Main
# =============================================================================


def main():
    if DRY_RUN:
        print("*** DRY RUN MODE - No changes will be made ***\n")

    check_yay()
    install_pacman_packages()
    install_aur_packages()
    install_uv()
    setup_git_config()
    generate_ssh_key()
    setup_dotfiles()
    setup_pi()
    setup_keyd()
    setup_gdm()
    install_nerd_fonts()
    setup_desktop_preferences()
    install_starship_prompt()
    install_omzsh_and_plugins()
    setup_zshrc()
    change_shell_to_zsh()
    print_post_install_notes()

    print("\n Setup complete! Please reboot.")


if __name__ == "__main__":
    main()
