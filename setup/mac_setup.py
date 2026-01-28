#!/usr/bin/env python3
"""
macOS Development Environment Setup Script

Sets up dotfiles and shell configuration.
Assumes packages (kitty, neovim, etc.) are already installed via Homebrew.

Run with: python3 mac_setup.py [--dry-run]
"""

import subprocess
import sys
from pathlib import Path

from packages import (
    NERD_FONTS,
    GIT_CONFIG,
    DOTFILE_REPOS,
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


def force_symlink(src: Path, dst: Path):
    """Create symlink, removing existing file/symlink if present."""
    if DRY_RUN:
        print(f"[DRY RUN] ln -sf {src} -> {dst}")
        return

    if dst.exists() or dst.is_symlink():
        dst.unlink() if dst.is_symlink() or dst.is_file() else run(["rm", "-rf", str(dst)])
    dst.symlink_to(src)
    print(f"Linked {src} -> {dst}")


# =============================================================================
# Setup Steps
# =============================================================================


def setup_git_config():
    section("Configuring git")
    for key, value in GIT_CONFIG.items():
        run(["git", "config", "--global", key, value])


def generate_ssh_key():
    section("Generating SSH key")
    ssh_dir = Path.home() / ".ssh"
    key_path = ssh_dir / "id_ed25519"

    if key_path.exists():
        print(f"SSH key already exists at {key_path}, skipping")
        return

    if not DRY_RUN:
        ssh_dir.mkdir(mode=0o700, exist_ok=True)

    email = GIT_CONFIG.get("user.email", "")
    run(["ssh-keygen", "-t", "ed25519", "-C", email, "-f", str(key_path), "-N", ""])


def setup_dotfiles():
    section("Setting up dotfiles")
    config_dir = Path.home() / ".config"
    if not DRY_RUN:
        config_dir.mkdir(exist_ok=True)

    # Clone neovim config
    nvim_dir = config_dir / "nvim"
    if nvim_dir.exists():
        print(f"{nvim_dir} already exists, skipping")
    else:
        run(["git", "clone", DOTFILE_REPOS["nvim"], str(nvim_dir)])

    dots_dir = Path.cwd().parent  # setup/ is inside dots/

    # Symlink kitty config
    kitty_src = dots_dir / "kitty"
    kitty_dst = config_dir / "kitty"
    if kitty_src.exists():
        force_symlink(kitty_src, kitty_dst)

    # Symlink starship config
    starship_src = dots_dir / "starship" / "starship.toml"
    starship_dst = config_dir / "starship.toml"
    if starship_src.exists():
        force_symlink(starship_src, starship_dst)


def setup_zshrc():
    """Symlink zshrc - must be called AFTER oh-my-zsh and starship are installed."""
    section("Setting up zshrc")
    dots_dir = Path.cwd().parent
    zshrc_src = dots_dir / "zsh" / ".zshrc"
    zshrc_dst = Path.home() / ".zshrc"
    if zshrc_src.exists():
        force_symlink(zshrc_src, zshrc_dst)


def install_nerd_fonts():
    section("Installing Nerd Fonts")
    # macOS uses ~/Library/Fonts
    fonts_dir = Path.home() / "Library" / "Fonts"
    if not DRY_RUN:
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


def change_shell_to_zsh():
    section("Changing default shell to zsh")
    zsh_path = "/bin/zsh"
    run(["chsh", "-s", zsh_path])


def print_post_install_notes():
    section("Post-installation notes")
    print("""
1. Open a new terminal window for zsh changes to take effect.

2. Add your SSH public key to GitHub:
   cat ~/.ssh/id_ed25519.pub

3. Run 'nvim' to trigger lazy.nvim plugin installation.

4. Set your terminal font to one of the installed Nerd Fonts:
   - BlexMono Nerd Font
   - ZedMono Nerd Font
""")


# =============================================================================
# Main
# =============================================================================


def main():
    if DRY_RUN:
        print("*** DRY RUN MODE - No changes will be made ***\n")

    setup_git_config()
    generate_ssh_key()
    setup_dotfiles()
    install_nerd_fonts()
    install_starship_prompt()
    install_omzsh_and_plugins()
    setup_zshrc()
    change_shell_to_zsh()
    print_post_install_notes()

    print("\n Setup complete!")


if __name__ == "__main__":
    main()
