Propose a scheduled task: work omp should repeat on a schedule (or once, later) without the user starting it, such as "every weekday at 9, check the CI dashboard and summarize failures". The user sees your draft in a confirmation card and can edit or decline it; nothing is scheduled until they confirm. Use it only when the user asks for recurring or later work.

Write `prompt` as complete instructions for a fresh session with no memory of this conversation: say what to look at, what to do, and what a good result is. Pick exactly one schedule:

- `scheduleKind: "cron"` with a five-field `cron` expression (`minute hour day month weekday`) in the user's local time, e.g. `0 9 * * 1-5`.
- `scheduleKind: "interval"` with `everyMinutes` (at least 5).
- `scheduleKind: "once"` with `at` as an ISO 8601 date-time.

Fill the fields the other kinds use with an empty string or 0. Runs are read-only unless the user raises that in the card. The result tells you whether the user created the task or declined it, and why.
