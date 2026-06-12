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
splitwise-cli auth whoami
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

## Failure Handling

| Problem | Cause | Fix |
|---|---|---|
| Empty list | No friends in account or auth scope issue | Verify account in app and run `auth whoami` |
| Authentication error | Missing/invalid credentials | Re-run `auth set-token` |

## Command Discovery

~~~bash
splitwise-cli friends --help
splitwise-cli friends list --help
~~~
