# hidden-spec-cli-01-entry

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Nurfajri880/hidden-spec-cli-01-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Nurfajri880/hidden-spec-cli-01-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**mend** — one patch tool for every AI edit format. It reads unified diffs, SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON, and applies them to a tree of files with 3-tier fuzzy line matching (exact, trailing-whitespace-tolerant, and indentation-tolerant), so edits land even when the model drifted whitespace or indentation. All-or-nothing: if any edit fails, no file is written.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Reads a patch from a file or stdin, applies it to the files in the current directory, and prints one line per changed file (`A`/`D`/`M`/`R`) plus `ok: N files`. Exit 0 on success, 1 if any edit fails, 2 on usage/format/parse errors.

---

<sub>Entered on [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
