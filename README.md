# splitwise-cli

A command-line client for the [Splitwise API](https://dev.splitwise.com), written in TypeScript.

## Installation

```bash
git clone <repo>
cd splitwise-cli
npm install
npm run build
npm install -g .      # registers `splitwise-cli` globally
```

During development (no build needed):

```bash
npm run dev -- <command> [options]
```

---

## Authentication

Get an API key at [splitwise.com/apps](https://www.splitwise.com/apps/register) → register an app → copy the API key.

```bash
# Store a pre-obtained access token (simplest)
splitwise-cli auth set-token YOUR_TOKEN

# Or store OAuth consumer key + secret (Client Credentials flow)
splitwise-cli auth set-oauth YOUR_KEY YOUR_SECRET

# Verify authentication
splitwise-cli auth whoami
splitwise-cli auth whoami -o json
```

Credentials are saved to `~/.splitwise-cli/config.json` with `600` permissions.

---

## Output format (`-o`)

Every command that returns data accepts `-o` / `--output` **after the subcommand**:

| Value | Description |
|---|---|
| `table` | Human-readable aligned table (default) |
| `json` | Pretty-printed JSON |
| `yaml` | YAML |

```bash
splitwise-cli expenses list -o json
splitwise-cli friends list -o yaml
```

---

## Commands

### `auth`

```bash
splitwise-cli auth set-token <token>
splitwise-cli auth set-oauth <consumerKey> <consumerSecret>
splitwise-cli auth whoami [-o table|json|yaml]
```

### `friends`

```bash
splitwise-cli friends list [-o table|json|yaml]
```

### `groups`

```bash
splitwise-cli groups list [-o table|json|yaml]
splitwise-cli groups get <id> [-o table|json|yaml]
```

### `expenses list`

```bash
splitwise-cli expenses list [options]
```

#### Options

| Flag | Short | Description |
|---|---|---|
| `--group <id\|name>` | `-g` | Filter by group ID or partial name (case-insensitive) |
| `--friend <id\|name>` | `-u` | Filter by friend ID or partial name |
| `--from <date>` | `-f` | Expenses on or after this date |
| `--to <date>` | | Expenses on or before this date |
| `--limit <n>` | `-l` | Max results per page (default: 20) |
| `--all` | | Fetch **all** pages automatically |
| `--mine` | | Only expenses where you are the payer |
| `--query <string>` | | Shorthand query string (see below) |
| `--output <format>` | `-o` | `table` (default), `json`, or `yaml` |

#### Date formats

`--from` and `--to` accept:

- **ISO date**: `2025-01-01`
- **Relative (negative = past)**: `-10d`, `-2w`, `-1month`, `-1y`
- **Relative units**: `d`/`day`/`days`, `w`/`week`/`weeks`, `m`/`month`/`months`, `y`/`year`/`years`

```bash
splitwise-cli expenses list --from -30d          # last 30 days
splitwise-cli expenses list --from -1month --to -1d
splitwise-cli expenses list --from 2025-01-01 --to 2025-12-31
```

#### Filtering by group or friend

Partial name matching is supported. If more than one match is found, the command
prints the ambiguous matches and exits. If no match is found, a warning is printed
and an empty list is returned.

```bash
# By exact or partial group name
splitwise-cli expenses list --group Flatmates
splitwise-cli expenses list -g flat              # partial — matches "Flatmates" if unique

# By group ID
splitwise-cli expenses list -g 12345

# By friend name (partial)
splitwise-cli expenses list --friend Alice
splitwise-cli expenses list -u ali               # partial

# By friend ID
splitwise-cli expenses list -u 42
```

#### Pagination

By default, the first page (up to `--limit` expenses) is returned.
Use `--all` to automatically walk every page:

```bash
splitwise-cli expenses list --all
splitwise-cli expenses list --all --group Flatmates -o json
```

> **Note:** `--all` uses the Splitwise SDK's async-iterator, which pages
> in batches of 100 until the server returns no more results.

#### Shorthand `--query`

A space-separated list of `key:value` tokens. Explicit flags override matching
`--query` tokens.

```bash
splitwise-cli expenses list --query "friend:Alice group:Flatmates from:-30d"
splitwise-cli expenses list --query "from:2025-01-01 to:2025-06-01" -o yaml

# Mix: --group overrides the group:... token in --query
splitwise-cli expenses list --query "group:flat from:-7d" --group "Other Group"
```

Supported tokens: `group:`, `friend:`, `from:`, `to:`.

#### Table vs JSON/YAML output

**Table** shows resolved names only (no IDs):

```
date        description    cost       paidBy    group
──────────  ─────────────  ─────────  ────────  ──────────
6/10/2026   Dinner         25.00 EUR  Alice     Flatmates
```

**JSON/YAML** includes both IDs and resolved names, plus the full split breakdown per expense:

```json
[
  {
    "id": 123,
    "date": "2026-06-10T00:00:00Z",
    "description": "Dinner",
    "cost": "25.00",
    "currency": "EUR",
    "paidBy": "Alice",
    "groupId": 45,
    "group": "Flatmates",
    "splits": [
      { "userId": 7,  "name": "Alice", "paid": "25.00", "owes": "8.33" },
      { "userId": 12, "name": "Bob",   "paid": "0.00",  "owes": "8.33" },
      { "userId": 23, "name": "Carol", "paid": "0.00",  "owes": "8.34" }
    ]
  }
]
```

### `expenses get <id>`

```bash
splitwise-cli expenses get 12345
splitwise-cli expenses get 12345 -o json
```

---

## Filtering: server-side vs client-side

| Filter | Where |
|---|---|
| `--group` | Server-side (`groupId` API param) — name resolved locally first |
| `--friend` | Server-side (`friendId` API param) — name resolved locally first |
| `--from` / `--to` | Server-side (`datedAfter` / `datedBefore` API params) |
| `--mine` | **Client-side** — the API has no "paid by me" filter |

---

## Examples

```bash
# Last 30 days, all pages, as JSON
splitwise-cli expenses list --from -30d --all -o json

# My expenses in a group this year
splitwise-cli expenses list -g Flatmates --from 2026-01-01 --mine

# Pipe JSON into jq
splitwise-cli expenses list --all -o json | jq '.[].description'

# Check who owes what on a specific expense
splitwise-cli expenses get 99999 -o yaml
```
