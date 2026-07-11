# pi-danger-guardrail

Pi extension that asks before dangerous bash commands or sensitive filesystem access run.

## What it checks

- Recursive deletes through wrappers: `timeout 10 sudo rm -rf ...`, `nice rm -rf ...`, `nohup ...`, `setsid`, `ionice`, `stdbuf`, `watch`, etc.
- Privilege escalation: `sudo`, `doas`, `pkexec`, `su`
- Disk/data destruction: `dd of=...`, `mkfs*`, `wipefs`, `blkdiscard`, partition tools, raw block-device redirects
- Broad permission changes: recursive `chmod 777`, recursive `chown`
- `find -delete` and dangerous `find -exec ...` commands
- Git destructive actions: `reset --hard`, `clean -f`, `push --force`, `checkout -f`, `restore --worktree`, `branch -D`, `stash clear/drop`, `worktree remove --force`
- Risky containers: privileged/host namespace/root/device/socket mounts, `--cap-add` with unsafe capabilities (e.g. `SYS_ADMIN`, `ALL`), unsafe `--security-opt`, volume deletes, prune, force remove
- Remote scripts/code: `curl ... | sh`, `wget -O- | python`, `sh -c "$(curl ...)"`, `npx`/`bunx`/`uvx`, package install lifecycle scripts (npm/pnpm/yarn/bun, plus `pip install`, `pipx`, `uv add|sync|pip install`, `cargo install`, `gem install`)
- Shell parsing risk: command substitutions, control-block keywords, `source`, shell script execution
- Inline interpreters: `python -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`, etc.
- Sensitive bash path references inside cwd; reads outside cwd are allowed
- Output and in-place writes: redirects, `curl -o`, `wget -O`, `sed -i`, `perl -pi`, archive `-C`, `rsync`/`install` destinations, `truncate`, `unlink`, `rmdir`
- Process/service disruption: `kill -9 -1`, `pkill`, `killall`, `systemctl stop/disable`, `mount`/`umount`, `loginctl`
- Persistence/autostart: `crontab`, systemd user units, desktop autostart, SSH `authorized_keys`, shell startup files
- Power actions: `reboot`, `shutdown`, `poweroff`, `systemctl reboot`, etc.
- Fork-bomb pattern
- File tool writes outside cwd, to system paths, shell startup/autostart files, `.env*`, keys/certs, or common credential paths; symlinks are canonicalized
- File tool reads/searches/listings of `.env*`, private keys/certs, or common credential paths inside cwd; reads outside cwd are allowed

## Behavior

When dangerous command or sensitive filesystem access appears in agent tools or user `!` bash command, Pi shows a two-option prompt:

- `Block`
- `Proceed`

Prompt includes 1-2 short reasons plus command/request preview. Default selection is `Block`. If Pi has no UI, action is blocked by default.

Reads outside cwd are allowed without prompt.

This is a confirmation guardrail, not an OS sandbox. For untrusted projects or stronger isolation, pair with pi's sandbox extension.

## Install

Dotfiles symlink `pi/extensions/` to `~/.pi/agent/extensions/`, where Pi auto-discovers this package via `index.ts`.

Run `/reload` or restart Pi after install.

## Check

```bash
npm run check
```

## Tests

The detection logic lives in `analysis.ts` (dependency-free) and is covered by `analysis.test.ts`:

```bash
node --test analysis.test.ts
```
