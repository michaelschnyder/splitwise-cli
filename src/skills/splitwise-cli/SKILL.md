---
name: splitwise-cli
description: Splitwise CLI command reference for login, profiles, cache, friends, groups, expenses, and skills.
metadata:
  version: "1.1.0"
  author: splitwise-cli
  tags: splitwise,cli,cache,expenses,groups,friends,login,profiles,write,import
  alwaysApply: "false"
---

# Splitwise CLI

Use this skill when you need command-driven access to Splitwise data, cache snapshots, or assistant skill files from a terminal or coding agent.

## Quick Reference

| Task | Command |
|------|---------|
| Check current user | `splitwise-cli login whoami` |
| List login credentials | `splitwise-cli login list` |
| List profiles | `splitwise-cli profiles list` |
| Add cache snapshots | `splitwise-cli cache add all` |
| Show cache status | `splitwise-cli cache status` |
| List friends and balances | `splitwise-cli friends list` |
| List groups | `splitwise-cli groups list` |
| Get one group | `splitwise-cli groups get <id>` |
| List recent expenses | `splitwise-cli expenses list --from -30d` |
| List all pages | `splitwise-cli expenses list --all -o json` |
| Get one expense | `splitwise-cli expenses get <id>` |
| Add an expense | `splitwise-cli expenses add -d "Dinner" -a 30.00` |
| Delete an expense | `splitwise-cli expenses delete <id>` |
| Import expenses | `splitwise-cli expenses import expenses.yaml` |
| Install skills | `splitwise-cli skills install claude` |

## Prerequisites

~~~bash
npm install
npm run build
~~~

Authenticate before data commands when online:

~~~bash
splitwise-cli login token <token>
splitwise-cli login whoami
~~~

## Quick Start

~~~bash
splitwise-cli login whoami
splitwise-cli cache add all
splitwise-cli friends list
splitwise-cli groups list
splitwise-cli expenses list --from -30d --all
~~~

## Command Groups

- login: manage named credentials, validate access, and inspect the current user.
- profiles: manage restrictions, active selection, cache defaults, API overrides, and one-way lock behavior.
- cache: export immutable snapshots, refresh them, inspect coverage, and delete cache targets.
- friends: list friends and balances.
- groups: list groups or fetch group details.
- expenses: query, create, delete, and import expenses with filters, output formats, and duplicate detection.
- skills: list/create/install packaged skill resources.

## Output Formats

Most list/get commands support `-o table|json|yaml`.

When `-o/--output` is omitted, list commands default to TUI table mode with one intro line and one summary footer line containing items, time, and source.

## Logging and Debug

Global controls:

- `--log <level>` where level is `error|warn|info|debug|trace`
- `-v`, `-vv`, `-vvv`, `-vvvv` for increasing verbosity
- `SW_DEBUG=1|yes|true` to force trace logs in every mode
- `--offline` to force cache-only reads and block network access

Stream behavior:

- structured payload output stays on stdout
- logs, warnings, errors, and progress/status go to stderr

Color behavior:

- colors are enabled for table/TUI mode
- logs are uncolored for json/yaml mode

## Common Workflows

### Offline data review

~~~bash
splitwise-cli cache add all
splitwise-cli --offline friends list
splitwise-cli --offline groups list
splitwise-cli --offline expenses list --from -30d --all
~~~

### Expense triage

~~~bash
splitwise-cli expenses list --query "group:Flatmates from:-14d" -o json
splitwise-cli expenses get <id> -o yaml
~~~

### Add a new expense

~~~bash
splitwise-cli expenses add -d "Groceries" -a 48.90 -C USD -g Flatmates --payer @me
splitwise-cli expenses add -d "Coffee" -a 4.50 --friend Alice
~~~

### Bulk import from file

~~~bash
splitwise-cli expenses import monthly.yaml --dry-run
splitwise-cli expenses import monthly.yaml --matcher intelligent --on-duplicate skip
splitwise-cli expenses import monthly.yaml --on-duplicate update
~~~

### Verify balances quickly

~~~bash
splitwise-cli friends list
splitwise-cli groups list
~~~

## Failure Handling

| Problem | Likely Cause | Fix |
|---|---|---|
| Not logged in | Missing credentials | Run `splitwise-cli login token <token>` |
| Empty list with warning | No name/ID match | Use exact ID or a more specific name |
| Ambiguous match error | Multiple partial matches | Use full name or numeric ID |
| Date parse error | Invalid relative/ISO value | Use `YYYY-MM-DD` or `-10d` style values |
| Offline request fails | Missing cache snapshot | Run `splitwise-cli cache add <entity>` first |
| Permission denied (write) | Profile blocks create/update/delete | Enable permissions in profile settings |

## Command Discovery

~~~bash
splitwise-cli --help
splitwise-cli cache --help
splitwise-cli expenses --help
splitwise-cli expenses list --help
splitwise-cli expenses add --help
splitwise-cli expenses delete --help
splitwise-cli expenses import --help
splitwise-cli skills --help
~~~

## Notes

- Use `expenses list --all` to paginate through all results.
- Use `expenses list --query` for shorthand filters such as `from:-30d`.
- `cache add` and `cache refresh` create immutable snapshots that can be reused with `--offline`.
- Write operations (`add`, `delete`, `import`) require profile permissions (`createExpenses`, `updateExpenses`, `deleteExpenses`).
- `expenses import` supports both simplified (group/friend by name) and full (per-user splits) record shapes.
