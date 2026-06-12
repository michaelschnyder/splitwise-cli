---
name: splitwise-expenses
description: Query and inspect Splitwise expenses with filters, pagination, and formats.
metadata:
  version: "1.0.0"
  author: splitwise-cli
  tags: splitwise,expenses,filters,pagination
  alwaysApply: "false"
---

# Splitwise Expenses

Query recent expenses, inspect details, and filter by group, friend, date, payer, and participant.

## Quick Reference

| Task | Command |
|------|---------|
| Last 30 days | `splitwise-cli expenses list --from -30d` |
| Full export | `splitwise-cli expenses list --all -o json` |
| Group filter | `splitwise-cli expenses list --group Flatmates` |
| Friend filter | `splitwise-cli expenses list --friend Alice` |
| Payer filter | `splitwise-cli expenses list --payer @me --all` |
| Participant filter | `splitwise-cli expenses list --involved Bob --all` |
| Fetch one expense | `splitwise-cli expenses get <id> -o yaml` |

## Prerequisites

~~~bash
splitwise-cli auth whoami
~~~

If auth is missing, set credentials first.

## List Expenses

~~~bash
splitwise-cli expenses list --from -30d --all
splitwise-cli expenses list --group Flatmates --friend Alice -o json
splitwise-cli expenses list --query "group:Flatmates from:-7d"
~~~

### Core Options

| Option | Purpose |
|---|---|
| `--group <id|name>` | Server-side group filter (name resolved locally) |
| `--friend <id|name>` | Server-side friend filter (name resolved locally) |
| `--from`, `--to` | Server-side date filter |
| `--max <n>` | Limit result size when not using `--all` |
| `--all` | Fetch every page |
| `--payer`, `--mine` | Client-side payer filter |
| `--involved` | Client-side participant filter |
| `--query` | Shorthand tokens: `group:`, `friend:`, `from:`, `to:` |

## Get One Expense

~~~bash
splitwise-cli expenses get <id>
splitwise-cli expenses get <id> -o yaml
~~~

## Supported Filters

- --group and --friend resolve names or IDs.
- --from and --to accept ISO and relative values (for example -7d).
- --involved and --payer are client-side participant filters.

## Date and Query Examples

~~~bash
splitwise-cli expenses list --from 2026-01-01 --to 2026-06-30
splitwise-cli expenses list --query "friend:Alice from:-14d"
splitwise-cli expenses list --query "group:flat from:-7d" --group Flatmates
~~~

## Typical Workflow

~~~bash
splitwise-cli expenses list --from -30d --all
splitwise-cli expenses list --group Flatmates --payer @me
splitwise-cli expenses get <id> -o yaml
~~~

## Output Guidance

- Use `table` for terminal review.
- Use `json` for scripts and downstream processing.
- Use `yaml` for readable long-form output.

~~~bash
splitwise-cli expenses list --all -o json
splitwise-cli expenses get <id> -o yaml
~~~

## Failure Handling

| Problem | Cause | Fix |
|---|---|---|
| Ambiguous group/friend | Partial name matches multiple entities | Use full name or numeric ID |
| No matching group/friend | Name does not resolve | Check `groups list` or `friends list` |
| Invalid date | Unsupported date format | Use ISO (`YYYY-MM-DD`) or relative (`-10d`) |
| Empty output unexpectedly | Strict filters + narrow date range | Broaden date range or remove filters |

## Command Discovery

~~~bash
splitwise-cli expenses --help
splitwise-cli expenses list --help
splitwise-cli expenses get --help
~~~
