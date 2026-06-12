# pi-ask-user-question

Adds `ask_user_question` to pi. Model can ask structured clarifying questions instead of guessing.

## Features

- 1-4 questions per tool call.
- Single-select and multi-select questions.
- Optional descriptions and preview text per option.
- Optional free-text `Type something.` fallback.
- Optional per-option notes via `n`.
- Submit review tab before answers return to model.
- RPC/simple fallback for non-TUI UI modes; clear `no_ui` result for print/json.

## Install

Dotfiles setup symlinks this package into `~/.pi/agent/extensions/pi-ask-user-question`, where Pi auto-discovers it.

Reload pi with `/reload` or restart session.

## Tool schema

```ts
ask_user_question({
  questions: [
    {
      question: string,
      header?: string,
      options: [
        {
          label: string,
          description?: string,
          preview?: string,
        }
      ],
      multiSelect?: boolean,
      allowOther?: boolean,
    }
  ]
})
```

Limits: 1-4 questions, each with 2-6 options. Reserved labels rejected: `Other`, `Type something.`, `Chat about this`, `Next →`, `Submit`, `Cancel`. Validation errors include `no_questions`, `too_many_questions`, `empty_options`, `too_many_options`, `duplicate_question`, `duplicate_option_label`, and `reserved_label`.

## TUI keys

- `Tab` / arrows: move between question tabs and Submit tab.
- `↑↓`: move option cursor.
- `Enter`: choose single option, toggle multi option, or submit.
- `Space`: toggle multi-select option.
- `n`: add/edit note for highlighted option.
- `Esc`: leave editor mode or cancel dialog.

## Return shape

```ts
{
  answers: [
    {
      questionIndex: number,
      question: string,
      kind: "option" | "custom" | "multi",
      answer: string | null,
      selected?: string[],
      notes?: string,
      optionNotes?: Record<string, string>,
      preview?: string,
      previews?: Record<string, string>
    }
  ],
  cancelled: boolean,
  error?: string
}
```
