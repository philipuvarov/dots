#!/usr/bin/env python3
"""Reapply the managed configuration for the current machine."""
from __future__ import annotations

import argparse
import platform as host_platform
from pathlib import Path

SUPPORTED_PLATFORMS = ("arch", "fedora", "macos")


def detect_platform() -> str:
    """Return the supported platform name for the current machine."""
    if host_platform.system() == "Darwin":
        return "macos"

    if host_platform.system() != "Linux":
        raise RuntimeError(f"Unsupported operating system: {host_platform.system()}")

    os_release = Path("/etc/os-release")
    if not os_release.exists():
        raise RuntimeError("Cannot detect Linux distribution: /etc/os-release is missing")

    values: dict[str, str] = {}
    for line in os_release.read_text().splitlines():
        if "=" not in line or line.startswith("#"):
            continue
        key, value = line.split("=", 1)
        values[key] = value.strip().strip('"')

    distro = values.get("ID", "")
    if distro in ("arch", "fedora"):
        return distro

    raise RuntimeError(f"Unsupported Linux distribution: {distro or 'unknown'}")


def normalize_platform(name: str) -> str:
    aliases = {"mac": "macos", "darwin": "macos"}
    normalized = aliases.get(name.lower(), name.lower())
    if normalized not in SUPPORTED_PLATFORMS:
        supported = ", ".join(SUPPORTED_PLATFORMS)
        raise ValueError(f"Unsupported platform '{name}'. Expected one of: {supported}")
    return normalized


def configure(
    platform_name: str | None = None, *, link_zshrc: bool = True
) -> None:
    """Apply packages, dotfiles, system files, services, and preferences."""
    platform_name = normalize_platform(platform_name) if platform_name else detect_platform()

    if platform_name == "fedora":
        import fedora_setup as setup

        setup.install_rpmfusion()
        setup.enable_copr_repos()
        setup.install_dnf_packages()
        setup.install_flatpak_packages()
        setup.setup_git_config()
        setup.setup_dotfiles()
        setup.setup_pi()
        setup.setup_keyd()
        setup.disable_gnome_super_keybindings()
    elif platform_name == "arch":
        import arch_setup as setup

        setup.check_yay()
        setup.install_pacman_packages()
        setup.install_aur_packages()
        setup.setup_git_config()
        setup.setup_dotfiles()
        setup.setup_pi()
        setup.setup_keyd()
        setup.setup_ly()
        setup.setup_desktop_preferences()
    else:
        import mac_setup as setup

        setup.install_homebrew_packages()
        setup.setup_git_config()
        setup.setup_dotfiles()
        setup.setup_pi()

    if link_zshrc:
        setup.setup_zshrc()

    print(f"\nConfiguration applied for {platform_name}.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--platform",
        help="override platform detection (arch, fedora, or macos)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print commands without running them",
    )
    args = parser.parse_args()

    if args.dry_run:
        print("*** DRY RUN MODE - No changes will be made ***\n")

    try:
        configure(args.platform)
    except (RuntimeError, ValueError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
