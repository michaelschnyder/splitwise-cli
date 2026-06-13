---
name: splitwise-cli
description: Splitwise CLI command reference for auth, friends, groups, and expenses.
metadata:
  version: "1.0.1"
  author: splitwise-cli
  tags: splitwise,cli,expenses,groups,friends,auth
  alwaysApply: "false"
---

# Splitwise CLI

Use this skill when you need command-driven access to Splitwise data from a terminal or coding agent.

## Quick Reference

| Task | Command |
|------|---------|
| Check current user | `splitwise-cli auth whoami` |
| List friends and balances | `splitwise-cli friends list` |
| List groups | `splitwise-cli groups list` |
| Get one group | `splitwise-cli groups get <id>` |
| List recent expenses | `splitwise-cli expenses list --from -30d` |
| List all pages | `splitwise-cli expenses list --all -o json` |
| Get one expense | `splitwise-cli expenses get <id>` |
| Install skills | `splitwise-cli skills install claude` |

## Prerequisites

~~~bash
npm install
npm run build
~~~

Authenticate before data commands:

~~~bash
splitwise-cli auth set-token <token>
splitwise-cli auth whoami
~~~

## Quick Start

~~~bash
splitwise-cli auth whoami
splitwise-cli friends list
splitwise-cli groups list
splitwise-cli expenses list --from -30d --all
~~~

## Command Groups

- auth: configure token/oauth credentials and verify current user.
- friends: list friends and balances.
- groups: list groups or fetch group details.
- expenses: query recent expenses with server-side filters and output formats.
- skills: list/create/install packaged skill resources.

## Output Formats

Most list/get commands support -o table|json|yaml.

When `-o/--output` is omitted, list commands default to TUI table mode with one intro line and one summary footer line (items/time/source).

## Common Workflows

### Expense triage

~~~bash
splitwise-cli expenses list --query "group:Flatmates from:-14d" -o json
splitwise-cli expenses get <id> -o yaml
~~~

### Verify balances quickly

~~~bash
splitwise-cli friends list
splitwise-cli groups list
~~~

## Failure Handling

| Problem | Likely Cause | Fix |
|---|---|---|
| Not authenticated | Missing credentials | Run `splitwise-cli auth set-token <token>` |
| Empty list with warning | No name/ID match | Use exact ID or a more specific name |
| Ambiguous match error | Multiple partial matches | Use full name or numeric ID |
| Date parse error | Invalid relative/ISO value | Use `YYYY-MM-DD` or `-10d` style values |

## Command Discovery

~~~bash
splitwise-cli --help
splitwise-cli expenses list --help
splitwise-cli skills --help
~~~

## Notes

- Use expenses list --all to paginate through all results.
- Use expenses list --query for shorthand filters such as from:-30d.
