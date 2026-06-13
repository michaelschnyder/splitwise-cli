---
name: splitwise-friends
description: List Splitwise friends and balances.
metadata:
  version: "1.0.1"
  author: splitwise-cli
  tags: splitwise,friends,balances
  alwaysApply: "false"
---

# Splitwise Friends

List friends and summarize balance state for quick settlement checks.

## Quick Reference

| Task | Command |
|------|---------|
| List friends | `splitwise-cli friends list` |
| List friends as JSON | `splitwise-cli friends list -o json` |
| List friends as YAML | `splitwise-cli friends list -o yaml` |

## Commands

~~~bash
splitwise-cli friends list
splitwise-cli friends list -o yaml
~~~

## Prerequisites

~~~bash
splitwise-cli login whoami
~~~

Balances are shown per currency. A friend with no balance is shown as settled up.

## Typical Workflow

~~~bash
splitwise-cli friends list
splitwise-cli expenses list --friend <id|name> --from -30d
~~~

## Output Notes

- Balance entries may contain multiple currencies.
- Settled relationships display as `settled up`.
- In implicit TUI mode (no `-o`), output is shown as:
  - one intro line,
  - readable title-cased table,
  - one summary footer line with items/time/source.

## Logging and Debug

- Use `--log <level>` (`error|warn|info|debug|trace`) for explicit logging.
- Use `-v/-vv/-vvv/-vvvv` for verbosity shorthand.
- Set `SW_DEBUG=1|yes|true` to force trace logs.
- In structured output modes, data remains on stdout and logs are emitted on stderr.

## Failure Handling

| Problem | Cause | Fix |
|---|---|---|
| Empty list | No friends in account or credential scope issue | Verify account in app and run `login whoami` |
| Login error | Missing/invalid credentials | Re-run `login token` |

## Command Discovery

~~~bash
splitwise-cli friends --help
splitwise-cli friends list --help
~~~
