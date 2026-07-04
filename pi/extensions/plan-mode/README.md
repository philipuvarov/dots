# Plan Mode

Global pi extension. Enables read-only planning, then approved execution with progress tracking.

## Use

- `/plan` toggles plan mode
- `/plan on` enables read-only planning
- `/plan off` disables/cancels
- `/plan execute` executes extracted plan
- `/plan status` or `/todos` shows progress
- `Ctrl+Alt+P` toggles
- `pi --plan` starts in plan mode

## Flow

1. Enable `/plan`.
2. Ask for implementation or analysis.
3. Agent inspects only and emits:

```text
Plan:
1. Step one
2. Step two
```

4. Choose `Execute plan` in prompt.
5. Extension restores original tools and tracks `[DONE:n]` markers.

## Safety

Plan mode activates only existing read-only tools: `read`, `grep`, `find`, `ls`, `bash`, common question/web tools if present.
`bash` is allowlisted and blocks destructive commands, writes, installs, git writes, sudo, editors, and shell-pipe execution.
