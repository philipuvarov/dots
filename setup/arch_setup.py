#!/usr/bin/env python3
"""
Arch Linux Desktop Environment Setup Script

Recreates a development environment based on captured setup history.
Run with: python3 arch_setup.py [--dry-run]

Requires: yay (AUR helper) - install manually first if not present
"""

import subprocess
import sys
from pathlib import Path

from packages import (
    COMMON_PACKAGES,
    ARCH_EXTRA_PACKAGES,
    NERD_FONTS,
    GIT_CONFIG,
    DOTFILE_REPOS,
    GNOME_KEYBINDINGS_TO_DISABLE,
)

DRY_RUN = "--dry-run" in sys.argv

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


def check_yay():
    """Check if yay is installed, offer to install if not."""
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
    run(["sudo", "pacman", "-S", "--needed", "--noconfirm"] + COMMON_PACKAGES)


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

    dots_dir = Path.cwd()

    # Symlink kitty config
    kitty_src = dots_dir / "kitty"
    kitty_dst = config_dir / "kitty"
    if kitty_src.exists() and not kitty_dst.exists():
        run(["ln", "-s", str(kitty_src), str(kitty_dst)])

    # Symlink zshrc
    zshrc_src = dots_dir / "zshrc" / ".zshrc"
    zshrc_dst = Path.home() / ".zshrc"
    if zshrc_src.exists() and not zshrc_dst.exists():
        run(["ln", "-s", str(zshrc_src), str(zshrc_dst)])

    # Symlink starship config
    starship_src = dots_dir / "starship" / "starship.toml"
    starship_dst = config_dir / "starship.toml"
    if starship_src.exists() and not starship_dst.exists():
        run(["ln", "-s", str(starship_src), str(starship_dst)])


def setup_keyd():
    section("Setting up keyd")
    dots_dir = Path.cwd()
    keyd_src = dots_dir / "keyd" / "default.conf"

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

        # Copy only .ttf files
        if not DRY_RUN:
            for ttf in extract_dir.glob("*.ttf"):
                run(["cp", str(ttf), str(fonts_dir)])


def disable_gnome_super_keybindings():
    section("Disabling GNOME Super+N keybindings")
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
            "sh -c \"$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)\" \"\" --unattended",
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

5. Set your terminal font to one of the installed Nerd Fonts:
   - BlexMono Nerd Font
   - ZedMono Nerd Font
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
    setup_keyd()
    install_nerd_fonts()
    disable_gnome_super_keybindings()
    change_shell_to_zsh()
    install_starship_prompt()
    install_omzsh_and_plugins()
    print_post_install_notes()

    print("\n Setup complete! Please reboot.")


if __name__ == "__main__":
    main()
