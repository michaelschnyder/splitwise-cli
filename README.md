# splitwise-cli

A terminal-first CLI for Splitwise with readable tables, structured JSON/YAML output, and built-in skill files for coding assistants.

## Links

- npm package: [splitwise-cli on npm](https://www.npmjs.com/package/splitwise-cli)
- Code repository: [michaelschnyder/splitwise-cli](https://github.com/michaelschnyder/splitwise-cli)
- Splitwise library: [keriwarr/splitwise](https://github.com/keriwarr/splitwise)
- Splitwise API docs: [dev.splitwise.com](https://dev.splitwise.com/)

## Installation

```bash
npm install -g splitwise-cli
# or
npx splitwise-cli --help
```

## Quick Start

```bash
# choose one auth mode
splitwise-cli auth set-token YOUR_TOKEN
# splitwise-cli auth set-oauth YOUR_KEY YOUR_SECRET

# verify auth
splitwise-cli auth whoami

# common commands
splitwise-cli friends list
splitwise-cli groups list
splitwise-cli expenses list --from -30d --all
```

Credentials are stored at `~/.splitwise-cli/config.json`.

## Supported Areas

| Area | Summary | Commands | Jump |
|---|---|---|---|
| Auth | Configure credentials and inspect active user | `set-token`, `set-oauth`, `whoami` | [Auth](#auth) |
| Friends | List friends and balances | `list` | [Friends](#friends) |
| Expenses | Query expenses with date/person/group filters | `list`, `get` | [Expenses](#expenses) |
| Skills | List/install/create assistant skill files | `list`, `path`, `install`, `create` | [Skills](#skills) |

## Output Formats

Use `-o` / `--output` when available.

| Format | Use case |
|---|---|
| `table` | default terminal view |
| `json` | scripts, pipes, automation |
| `yaml` | readable structured output |

```bash
splitwise-cli friends list -o yaml
splitwise-cli expenses list --from -7d -o json
```

## Auth

Create credentials at [splitwise.com/apps/register](https://www.splitwise.com/apps/register).

### Commands

```bash
splitwise-cli auth set-token YOUR_TOKEN
splitwise-cli auth set-oauth YOUR_KEY YOUR_SECRET
splitwise-cli auth whoami
splitwise-cli auth whoami -o json
```

### Example Response (`auth whoami -o json`)

```json
{
  "id": 12345678,
  "name": "Alex Example",
  "email": "alex@example.com"
}
```

## Friends

### Commands

```bash
splitwise-cli friends list
splitwise-cli friends list -o json
```

### Example Response (`friends list`)

```text
id        name            balance
--------  --------------  -----------------
11111111  Alice Example   -12.40 USD
22222222  Bob Example     settled up
```

### Example Response (`friends list -o json`)

```json
[
  {
    "id": 11111111,
    "name": "Alice Example",
    "balance": "-12.40 USD"
  },
  {
    "id": 22222222,
    "name": "Bob Example",
    "balance": "settled up"
  }
]
```

## Expenses

### Commands

```bash
splitwise-cli expenses list [options]
splitwise-cli expenses get <expenseId>
```

### Core Options (`expenses list`)

| Flag | Short | Description |
|---|---|---|
| `--group <id|name>` | `-g` | filter by group ID or partial group name |
| `--friend <id|name>` | `-u` | filter by friend ID or partial friend name |
| `--from <date>` | `-f` | include expenses on or after date |
| `--to <date>` |  | include expenses on or before date |
| `--max <n>` | `-m` | max rows unless `--all` is used |
| `--all` |  | walk all API pages |
| `--mine` |  | shorthand for `--payer @me` |
| `--involved <@me|id|name>` |  | client-side participant filter |
| `--payer <@me|id|name>` |  | client-side payer filter |
| `--query <string>` |  | shorthand key:value query |
| `--output <format>` | `-o` | `table`, `json`, or `yaml` |

Date values support ISO (`2026-01-01`) and relative values (`-10d`, `-2w`, `-1month`, `-1y`).

### Example Commands

```bash
splitwise-cli expenses list --from -30d --all -o json
splitwise-cli expenses list --group Flatmates --mine --from -1month
splitwise-cli expenses list --involved Alice --from -14d
splitwise-cli expenses get 99999 -o yaml
```

### Example Response (`expenses list`)

```text
date        group      paidBy        description            cost        category
----------  ---------  ------------  ---------------------  ----------  --------
6/10/2026   Flatmates  Alex Example  Groceries              48.90 USD   Food
6/09/2026   Flatmates  Alex Example  Rent transfer -> Jo    650.00 USD  Payment
```

### Example Response (`expenses list -o json`)

```json
[
  {
    "id": 99999,
    "date": "2026-06-10T10:25:00Z",
    "description": "Groceries",
    "cost": "48.90",
    "currency": "USD",
    "category": "Food",
    "isPayment": false,
    "paidBy": "Alex Example",
    "group": "Flatmates",
    "splits": [
      { "userId": 12345678, "name": "Alex Example", "paid": "48.90", "owes": "24.45" },
      { "userId": 87654321, "name": "Jo Example", "paid": "0.00", "owes": "24.45" }
    ],
    "createdAt": "2026-06-10T10:25:10Z",
    "createdByName": "Alex Example",
    "updatedByName": "Alex Example",
    "deletedByName": ""
  }
]
```

## Skills

Built-in skills are copied into the package and can be installed for supported assistants.

### Built-in Skill Names

- `splitwise-cli`
- `splitwise-auth`
- `splitwise-expenses`
- `splitwise-groups`
- `splitwise-friends`

### Commands

```bash
splitwise-cli skills list
splitwise-cli skills path [platform]
splitwise-cli skills install [platform]
splitwise-cli skills create
```

Supported platform values: `claude`, `cursor`, `codex`, `opencode`, `windsurf`, `gemini`, `pi`, `all`.

### Example Response (`skills list -o yaml`)

```yaml
- name: splitwise-cli
  type: skill
  description: Top-level splitwise-cli command reference and workflow.
- name: splitwise-expenses
  type: skill
  description: Expense listing filters, date parsing, and output behavior.
```

## Other Commands

Groups are also supported with:

- `splitwise-cli groups list`
- `splitwise-cli groups get <groupId>`

## Development

```bash
npm install
npm run build
npm run dev -- expenses list --from -7d
```
