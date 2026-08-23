#!/usr/bin/env python3
"""Bootstrap a new machine and apply its managed configuration."""
from __future__ import annotations

import argparse
import importlib

from configure import detect_platform, normalize_platform

BOOTSTRAP_MODULES = {
    "arch": "arch_setup",
    "fedora": "fedora_setup",
    "macos": "mac_setup",
}


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

    try:
        platform_name = normalize_platform(args.platform) if args.platform else detect_platform()
    except (RuntimeError, ValueError) as error:
        parser.error(str(error))

    module = importlib.import_module(BOOTSTRAP_MODULES[platform_name])
    module.main()


if __name__ == "__main__":
    main()
