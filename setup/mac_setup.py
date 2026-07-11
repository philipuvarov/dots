#!/usr/bin/env python3
"""
macOS Development Environment Setup Script

Installs core packages, dotfiles, fonts, and shell configuration.

Run with: python3 mac_setup.py [--dry-run]
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from packages import (
    NERD_FONTS,
    GIT_CONFIG,
    DOTFILE_REPOS,
    HOMEBREW_FORMULAE,
    HOMEBREW_CASKS,
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


def check_homebrew():
    """Check if Homebrew is installed."""
    if DRY_RUN:
        print("[DRY RUN] which brew")
        return

    result = subprocess.run(["which", "brew"], capture_output=True, text=True)
    if result.returncode == 0:
        return

    print("Homebrew is not installed.")
    print("Install it with:")
    print(
        '  /bin/bash -c "$(curl -fsSL '
        'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    )
    sys.exit(1)


def install_homebrew_packages():
    section("Installing Homebrew packages")
    check_homebrew()

    if HOMEBREW_FORMULAE:
        run(["brew", "install"] + HOMEBREW_FORMULAE)

    if HOMEBREW_CASKS:
        run(["brew", "install", "--cask"] + HOMEBREW_CASKS)


def install_uv():
    section("Installing uv (Python package manager)")
    run("curl -LsSf https://astral.sh/uv/install.sh | sh", shell=True)


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

    # Symlink terminal configs
    symlink_path(DOTS_DIR / "kitty", config_dir / "kitty")

    ghostty_config_dir = (
        Path.home() / "Library" / "Application Support" / "com.mitchellh.ghostty"
    )
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

4. Ghostty uses BlexMono Nerd Font and the Oxocarbon theme; its config is
   linked under ~/Library/Application Support/com.mitchellh.ghostty.

5. Kitty remains available with its Aura theme at ~/.config/kitty.

6. Launch `herdr` to create or attach to its persistent terminal session.
""")


# =============================================================================
# Main
# =============================================================================


def main():
    if DRY_RUN:
        print("*** DRY RUN MODE - No changes will be made ***\n")

    install_homebrew_packages()
    install_uv()
    setup_git_config()
    generate_ssh_key()
    setup_dotfiles()
    setup_pi()
    install_nerd_fonts()
    install_starship_prompt()
    install_omzsh_and_plugins()
    setup_zshrc()
    change_shell_to_zsh()
    print_post_install_notes()

    print("\n Setup complete!")


if __name__ == "__main__":
    main()
