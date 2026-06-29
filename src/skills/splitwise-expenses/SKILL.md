---
name: splitwise-expenses
description: Query, create, delete, and import Splitwise expenses with filters, pagination, and formats.
metadata:
  version: "1.2.2"
  author: splitwise-cli
  tags: splitwise,expenses,filters,pagination,write,import
  alwaysApply: "false"
---

# Splitwise Expenses

Query recent expenses, inspect details, and filter by group, friend, date, payer, and participant. Create new expenses, delete existing ones, and bulk-import from YAML/JSON files.

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
| Add an expense | `splitwise-cli expenses add -d "Dinner" -a 30.00 -C EUR` |
| Delete an expense | `splitwise-cli expenses delete <id>` |
| Import from file | `splitwise-cli expenses import expenses.yaml` |

## Prerequisites

~~~bash
splitwise-cli login whoami
~~~

If login is missing, set credentials first. Write operations (`add`, `delete`, `import`) also require `createExpenses`, `updateExpenses`, or `deleteExpenses` permissions to be enabled in the active profile.

## List Expenses

~~~bash
splitwise-cli expenses list --from -30d --all
splitwise-cli expenses list --group Flatmates --friend Alice -o json
splitwise-cli expenses list --query "group:Flatmates from:-7d"
~~~

### Core Options

| Option | Purpose |
|---|---|
| `--group <id\|name>` | Server-side group filter (name resolved locally) |
| `--friend <id\|name>` | Server-side friend filter (name resolved locally) |
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

## Add an Expense

~~~bash
splitwise-cli expenses add -d "Dinner" -a 30.00
splitwise-cli expenses add -d "Groceries" -a 48.90 -C USD -g Flatmates --payer @me
splitwise-cli expenses add -d "Coffee" -a 4.50 --friend Alice --user-share 123:2.25:2.25 --user-share 201:0:2.25
~~~

### Core Options (`expenses add`)

| Option | Purpose |
|---|---|
| `-d, --description <text>` | Expense description (required) |
| `-a, --cost <amount>` | Total cost (required) |
| `--date <date>` | Expense date (`YYYY-MM-DD` or relative) |
| `-C, --currency <code>` | Currency code (default: account default) |
| `-g, --group <id\|name>` | Group ID or partial name |
| `-u, --friend <id\|name>` | Friend ID or partial name |
| `--notes <text>` | Additional notes/details |
| `--category <id\|name>` | Category ID or partial name |
| `--payer <@me\|id\|name>` | User who paid (default: `@me`) |
| `--split-equally` | Split equally among payer and group/friend (default) |
| `--user-share <id:paid:owed>` | Custom share — repeat for each participant |

When no `--user-share` flags are provided, the expense is split equally between the payer and the specified group or friend.

### Output

The `add` command returns the created expense with all fields including the **expense ID**, description, cost, currency, date, category, group, and payment status.

~~~bash
$ splitwise-cli expenses add -d "Lunch" -a 25.50 --friend Alice
id          123456789
description Lunch
cost        25.50
currency    USD
date        2026-06-29
category    Dining
group       
payment     false
~~~

The **expense ID** (`id`) uniquely identifies the expense for later reference, updates, or deletion. Agents can capture this ID from the output to track created expenses.

## Delete an Expense

~~~bash
splitwise-cli expenses delete <id>
splitwise-cli expenses delete <id> --yes      # skip confirmation prompt
~~~

Deletion prompts for confirmation in TUI mode. Pass `--yes` to confirm non-interactively.

## Import Expenses from a File

Bulk-create (and optionally update) expenses from a YAML or JSON file.

~~~bash
splitwise-cli expenses import expenses.yaml
splitwise-cli expenses import expenses.json --dry-run
splitwise-cli expenses import expenses.yaml --matcher intelligent --on-duplicate update
splitwise-cli expenses import expenses.yaml --match-scope account
splitwise-cli expenses import expenses.yaml --log debug --match-scope target
~~~

### Import File Formats

Files must contain a list of expense records. Two shapes are supported and can be mixed within a single file.

**Simplified shape** — group/friend resolved by name:

~~~yaml
- description: Dinner
  cost: "30.00"
  date: "2024-01-15"
  currency: USD
  group: Flatmates
~~~

**Full shape** — explicit per-user splits (requires `userId` in each entry):

~~~yaml
- description: Dinner
  cost: "30.00"
  date: "2024-01-15"
  currency: USD
  splits:
    - userId: 123
      paidShare: "30"
      owedShare: "15"
    - userId: 456
      owedShare: "15"
~~~

JSON format follows the same structure.

### Core Options (`expenses import`)

| Option | Purpose |
|---|---|
| `--dry-run` | Preview changes without writing anything |
| `--matcher <type>` | Duplicate detection: `exact` (default) or `intelligent` |
| `--match-scope <scope>` | Duplicate scope: `target` (default) or `account` |
| `--on-duplicate <action>` | Action when duplicate found: `skip` (default) or `update` |
| `--limit <number>` | Process only the first N records from the file |
| `--no-cache` | Disable cache update after import |
| `-o, --output <format>` | Output format |

### Matchers

- **`exact`** — matches on description, cost, currency, date, and user distribution (all must be identical).
- **`intelligent`** — fuzzy matching: date within ±5 days or a single adjacent-key digit typo per date component; cost with a single adjacent-key digit typo; currency must match exactly.

Keyboard adjacency includes both the top-row digit keys (horizontal neighbours) and standard numpad vertical neighbours (1↔4, 2↔5, 3↔6, 4↔7, 5↔8, 6↔9).

### Duplicate Handling

- `--on-duplicate=skip` (default): matched expenses are reported but not modified.
- `--on-duplicate=update`: only fields that differ from the match are sent; no API call is made when nothing has changed.
- `--dry-run` blocks both creates and updates regardless of other flags.
- `--match-scope=target` (default): duplicates are matched only within the import target.
- `--match-scope=account`: duplicates are matched across the full account in the imported date window.
- Invalid values for `--matcher`, `--match-scope`, or `--on-duplicate` fail fast with an explicit error.

### Import Summary Output

After processing, a summary is printed to stderr along with details for each imported expense:

~~~bash
$ splitwise-cli expenses import expenses.yaml
i [expenses import] Parsing import file...
✔ [expenses import] Parsed 3 record(s)
i [expenses import] Fetching reference data...
✔ [expenses import] Reference data loaded
i [expenses import] Fetching existing expenses...
✔ [expenses import] Fetched existing expenses in date window
i [expenses import] Matcher: exact
i [expenses import] Match scope: target
i [expenses import] On duplicate: skip
i [expenses import] Loaded 2 existing expense(s) in date window.
i [expenses import] Found 1 existing expense(s) in import scope.
i [expenses import] Processing records...
✔ [expenses import] Done

i [expenses import] Import Summary:
i [expenses import]   Created: 2
i [expenses import]   Updated: 0
i [expenses import]   Skipped: 1
i [expenses import]   Errors:  0
~~~

Debug traces for per-record match decisions are available with:

~~~bash
splitwise-cli expenses import expenses.yaml --log debug --matcher intelligent --match-scope target
~~~

Each created expense shows:

| Field | Example |
|-------|---------|
| **id** | 123456789 |
| **description** | Dinner |
| **cost** | 30.00 |
| **currency** | USD |
| **date** | 2026-06-29 |
| **category** | Dining |
| **group** | Flatmates |
| **payment** | false |

The **expense ID** (`id`) uniquely identifies each created or updated expense. The import command tracks these IDs internally, allowing agents to reference created/updated expenses by their Splitwise ID.

When using `--limit <number>`, the import processes only the first N records from the file:

~~~bash
splitwise-cli expenses import large-file.yaml --limit 5 --dry-run
# Processes only first 5 records
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
splitwise-cli expenses add -d "Lunch" -a 15.00 --friend Alice
splitwise-cli expenses import monthly.yaml --dry-run
splitwise-cli expenses import monthly.yaml --matcher intelligent --on-duplicate skip
~~~

## Output Guidance

- Use `table` for terminal review.
- Use `json` for scripts and downstream processing.
- Use `yaml` for readable long-form output.
- In implicit TUI mode (no `-o`), list output includes:
  - one intro line,
  - title-cased table headers with `ID` as first column,
  - one summary footer line with items/time/source.
- Expense `Share` uses color only (green/red/dim) with numeric values; payment descriptions are dimmed.

## Logging and Debug

- Use `--log <level>` (`error|warn|info|debug|trace`) for explicit logging.
- Use `-v/-vv/-vvv/-vvvv` for verbosity shorthand.
- `SW_DEBUG=1|yes|true` forces trace-level logs in any output mode.
- Structured payload (`-o json` or `-o yaml`) remains on stdout while logs/progress are emitted on stderr.

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
| Permission denied (write) | Profile lacks `createExpenses`/`deleteExpenses` | Enable in profile or use unrestricted profile |
| Import parse error | Invalid YAML/JSON file | Check file syntax and field names |

## Command Discovery

~~~bash
splitwise-cli expenses --help
splitwise-cli expenses list --help
splitwise-cli expenses add --help
splitwise-cli expenses delete --help
splitwise-cli expenses import --help
splitwise-cli expenses get --help
~~~
