#!/usr/bin/env python3
"""
Fedora Desktop Environment Setup Script

Recreates a development environment based on captured setup history.
Run with: python3 fedora_setup.py [--dry-run]
"""

import subprocess
import os
import sys
from pathlib import Path

DRY_RUN = "--dry-run" in sys.argv

# =============================================================================
# Configuration
# =============================================================================

DNF_PACKAGES = [
    "neovim",
    "kitty",
    "zsh",
    "lazygit",
    "steam",
    "telegram-desktop",
    "luarocks",
    "fzf",
]

COPR_REPOS = [
    "blakegardner/xremap",
    "dejan/lazygit",
]

COPR_PACKAGES = [
    "xremap",
]

FLATPAK_PACKAGES = [
    "com.bitwarden.desktop",
    "com.discordapp.Discord",
]

RPMFUSION_FREE_URL = (
    "https://download1.rpmfusion.org/free/fedora/"
    "rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm"
)

DOTFILE_REPOS = {
    "nvim": "https://github.com/dotfiles-user/kickstart.nvim.git",
    "dots": "https://github.com/dotfiles-user/dots.git",
}

GIT_CONFIG = {
    "user.email": "user@example.invalid",
    "user.name": "dotfiles-user",
}

# GNOME keybindings to disable (free up Super+N for other apps)
GNOME_KEYBINDINGS_TO_DISABLE = [
    f"org.gnome.shell.keybindings switch-to-application-{i}" for i in range(1, 10)
]

NERD_FONTS = [
    "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/IBMPlexMono.zip",
    "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/ZedMono.zip",
]

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
    run(["sudo", "dnf", "install", "-y"] + DNF_PACKAGES)


def install_copr_packages():
    section("Installing COPR packages")
    run(["sudo", "dnf", "install", "-y"] + COPR_PACKAGES)


def install_flatpak_packages():
    section("Installing Flatpak packages")
    for pkg in FLATPAK_PACKAGES:
        run(["flatpak", "install", "-y", "flathub", pkg])


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

    # Clone dots repo and symlink configs
    dots_dir = Path.home() / ".dots"
    if dots_dir.exists():
        print(f"{dots_dir} already exists, skipping clone")
    else:
        run(["git", "clone", DOTFILE_REPOS["dots"], str(dots_dir)])

    # Symlink kitty config
    kitty_src = dots_dir / "kitty"
    kitty_dst = config_dir / "kitty"
    if kitty_src.exists() and not kitty_dst.exists():
        run(["ln", "-s", str(kitty_src), str(kitty_dst)])

    # Symlink xremap config
    xremap_src = dots_dir / "xremap"
    xremap_dst = config_dir / "xremap"
    if xremap_src.exists() and not xremap_dst.exists():
        run(["ln", "-s", str(xremap_src), str(xremap_dst)])

    # Symlink zshrc
    zshrc_src = dots_dir / "zshrc"
    zshrc_dst = Path.home() / ".zshrc"
    if zshrc_src.exists() and not zshrc_dst.exists():
        run(["ln", "-s", str(zshrc_src), str(zshrc_dst)])


def setup_xremap_service():
    section("Setting up xremap systemd service")

    # Add user to input group for rootless xremap
    run(["sudo", "usermod", "-aG", "input", os.environ["USER"]])

    # Create udev rule for uinput access
    udev_rule = 'KERNEL=="uinput", GROUP="input", TAG+="uaccess"'
    udev_path = "/etc/udev/rules.d/99-input.rules"
    run(f"echo '{udev_rule}' | sudo tee {udev_path}", shell=True)

    # Create systemd user service
    service_dir = Path.home() / ".config" / "systemd" / "user"
    service_dir.mkdir(parents=True, exist_ok=True)

    service_content = """\
[Unit]
Description=xremap key remapper

[Service]
ExecStart=/usr/bin/xremap %h/.config/xremap/config.yml
Restart=always

[Install]
WantedBy=default.target
"""
    service_path = service_dir / "xremap.service"
    if not DRY_RUN:
        service_path.write_text(service_content)
        print(f"Created {service_path}")
    else:
        print(f"[DRY RUN] Would create {service_path}")

    run(["systemctl", "--user", "daemon-reload"])
    run(["systemctl", "--user", "enable", "xremap"])
    print("NOTE: xremap service will start after reboot (needs input group membership)")


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

    run(["fc-cache", "-fv"])


def disable_gnome_super_keybindings():
    section("Disabling GNOME Super+N keybindings")
    for binding in GNOME_KEYBINDINGS_TO_DISABLE:
        schema, key = binding.rsplit(" ", 1)
        run(["gsettings", "set", schema, key, "[]"])


def change_shell_to_zsh():
    section("Changing default shell to zsh")
    zsh_path = "/usr/bin/zsh"
    run(["sudo", "chsh", "-s", zsh_path, os.environ["USER"]])


def print_post_install_notes():
    section("Post-installation notes")
    print("""
1. REBOOT REQUIRED for:
   - xremap service (input group membership)
   - zsh as default shell

2. Add your SSH public key to GitHub:
   cat ~/.ssh/id_ed25519.pub

3. Run 'nvim' to trigger lazy.nvim plugin installation.

4. Check xremap is running after reboot:
   systemctl --user status xremap

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

    install_rpmfusion()
    enable_copr_repos()
    install_dnf_packages()
    install_copr_packages()
    install_flatpak_packages()
    install_uv()
    setup_git_config()
    generate_ssh_key()
    setup_dotfiles()
    setup_xremap_service()
    install_nerd_fonts()
    disable_gnome_super_keybindings()
    change_shell_to_zsh()
    print_post_install_notes()

    print("\n✓ Setup complete! Please reboot.")


if __name__ == "__main__":
    main()
