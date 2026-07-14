# Plan Mode

Global pi extension for read-only planning followed by approved execution.

## Use

- `/plan` toggles plan mode
- `/plan on` enables read-only planning
- `/plan off` disables/cancels it
- `/plan execute` executes the submitted plan
- `/plan status` or `/todos` shows progress
- `Ctrl+Alt+P` toggles plan mode
- `pi --plan` starts in plan mode

## Flow

1. Enable `/plan`.
2. Ask for implementation or analysis.
3. The agent investigates with read-only tools and submits a structured plan of at most eight concise steps.
4. Expand the plan card to see per-step paths, constraints, rationale, and verification details.
5. Choose `Execute plan`, `Refine plan`, `Stay in plan mode`, or `Disable plan mode`.
6. During execution, the agent marks progress with `[DONE:n]` markers.

In print/JSON mode, where there is no interactive approval dialog, the extension falls back to a compact Markdown `Plan:` list.

## Mode transitions

Mode instructions are hidden conversation context rather than sticky system-prompt overrides. On every user turn the extension explicitly identifies planning, execution, or normal mode and filters older mode messages from model context. Exiting plan mode therefore takes effect on the next request, even in a long session.

Plan previews and completion cards are persisted as TUI-only custom entries. They are not sent back to the model and cannot accidentally trigger another agent turn.

## Safety

Plan mode activates only existing read-only tools plus the internal `submit_plan` tool. Bash is deny-by-default and checks every compound-command segment. It blocks writes, installs, unsafe Git operations, arbitrary interpreters, and output redirection while permitting common repository inspection commands such as `git -C <repo> status` and `git worktree list`.

## Tests

```bash
node --test utils.test.ts
```
