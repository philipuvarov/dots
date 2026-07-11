# system-notify

Pi extension that sends desktop notifications from the TUI:

- "Job finished" when the agent completes a run (`agent_end`)
- "Waiting for your input" when a UI prompt opens (`select`, `confirm`, `input`, `editor`, `custom`)

## Behavior

- Notifications are suppressed while the terminal is focused (tracked via xterm
  focus reporting, `CSI ?1004h`). Set `PI_SYSTEM_NOTIFY_SUPPRESS_FOCUSED=0` to
  always notify.
- macOS: uses the terminal's native notification protocol (OSC 99 for kitty,
  OSC 777 for Ghostty, iTerm2, WezTerm, and compatible terminals). This keeps
  notifications owned by the terminal instead of Script Editor.
- Linux: uses `notify-send`.
- Only active in TUI mode.

## Check

```bash
pi --offline --no-extensions --extension ./index.ts --list-models
```
