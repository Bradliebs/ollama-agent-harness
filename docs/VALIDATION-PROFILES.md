# Output validation profiles

The harness can score every final assistant answer against a deterministic
contract called a **validation profile**. The profile is selected per turn —
either manually from the **Output Validation** settings panel or automatically
from the prompt.

## Built-in profiles

| Profile | When it fits |
|---|---|
| `oracle-prime` | Strategy, decisions, risk, uncertainty, multi-scenario reasoning. Default neutral fallback. |
| `factual-answer` | Current or factual questions (weather, news, prices, "who/what/when/where"). |
| `coding-answer` | Code changes, refactors, debugging, tests, build commands, file edits. |
| `tool-result-summary` | Summarising terminal output, command results, stack traces. |

## Auto-select rules

When **Auto-select best contract** is on, each prompt is matched against keyword
patterns in this order:

1. **Short or vague prompts** (under 12 characters, or starting with phrases
   like "you decide", "whatever", "anything", "surprise me", "up to you", "your
   choice", "idk", "dunno") → fall back to `oracle-prime` and are flagged as
   **unmatched**.
2. **Tool / terminal signals** (`stdout`, `stderr`, `exit code`, `tool result`,
   `terminal output`, `command output`, `stack trace`) → `tool-result-summary`.
3. **Code signals** (`code`, `coding`, `implement`, `refactor`, `debug`,
   `typecheck`, `unit test`, `pull request`, `commit`, language names like
   `typescript`/`javascript`/`python`, file extensions like `.ts`/`.tsx`/`.js`/
   `.py`, package managers like `npm`/`yarn`/`pnpm`, `jest`, `eslint`, `compile`,
   `function`, `class`, `method`, `api endpoint`) → `coding-answer`.
4. **Factual signals** (`weather`, `today`, `current`, `latest`, `news`,
   `price`, `stock`, `who is`, `what is`, `when is`, `where is`, `source`,
   `according to`, `factual`) → `factual-answer`.
5. **Decision signals** (`decision`, `strategy`, `risk`, `scenario`, `tradeoff`,
   `alternative`, `recommend`, `confidence`, `uncertainty`, `forecast`, `plan`)
   → `oracle-prime`.
6. **Anything else** → `oracle-prime` (flagged as **unmatched**).

The matched/unmatched flag is shown in the chat UI as either
"Auto-selected `<profile>`" or "Defaulted to `<profile>`", along with the
reason.

## Settings

Open the right-side **Output Validation** panel to control:

* **Validate final answers** — enables validation globally.
* **Auto-select best contract** — uses the rules above. Turn off to always use
  the manually selected profile.
* **Skip validation on low-signal prompts** — when auto-select cannot find a
  strong signal, skip validation entirely instead of running Oracle Prime
  against small talk.
* **Reasoning contract** — manual override profile when auto-select is off.

You can also skip validation for a single message with the **Skip validation
for this turn** checkbox under the chat input. The global setting is not
changed.

## Feedback

Each auto-selected profile shows 👍 / 👎 buttons. Clicks are recorded as eval
trace runs tagged `profile-feedback` and `profile-feedback:up` or
`profile-feedback:down`, and roll up into the **Output validation trends** view.

## Custom profiles

You can add custom deterministic profiles in JSON via the **Custom profiles**
section. Each custom profile lists `checks` with `code`, `severity` (`fail` or
`warn`), `requiresAny` keywords, and an optional `scorePenalty`. Custom
profiles are saved to `.harness/output-validation-profiles.json`.
