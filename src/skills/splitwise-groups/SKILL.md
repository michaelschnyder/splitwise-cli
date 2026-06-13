---
name: splitwise-groups
description: Work with Splitwise groups from splitwise-cli.
metadata:
  version: "1.0.1"
  author: splitwise-cli
  tags: splitwise,groups,members
  alwaysApply: "false"
---

# Splitwise Groups

Inspect groups and group membership for downstream expense filtering.

## Quick Reference

| Task | Command |
|------|---------|
| List all groups | `splitwise-cli groups list` |
| List groups as JSON | `splitwise-cli groups list -o json` |
| Get one group | `splitwise-cli groups get <id>` |
| Get one group as YAML | `splitwise-cli groups get <id> -o yaml` |

## Commands

~~~bash
splitwise-cli groups list
splitwise-cli groups list -o json
splitwise-cli groups get <id>
~~~

Use groups list to discover IDs, then groups get to inspect membership.

## Prerequisites

~~~bash
splitwise-cli auth whoami
~~~

## Typical Workflow

~~~bash
splitwise-cli groups list
splitwise-cli groups get <id>
splitwise-cli expenses list --group <id> --from -30d
~~~

## Output Notes

- In implicit TUI mode (no `-o`), groups list output includes one intro line, a readable title-cased table, and one summary footer line with items/time/source.

## Failure Handling

| Problem | Cause | Fix |
|---|---|---|
| Group not found | Invalid ID | Re-run `groups list` and use returned ID |
| Authentication error | Missing/invalid credentials | Run `splitwise-cli auth whoami` then re-authenticate |

## Command Discovery

~~~bash
splitwise-cli groups --help
splitwise-cli groups list --help
splitwise-cli groups get --help
~~~
