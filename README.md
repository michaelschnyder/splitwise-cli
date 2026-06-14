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
# save login credentials (named entries are supported)
splitwise-cli login token YOUR_TOKEN --name personal
# splitwise-cli login oauth YOUR_KEY YOUR_SECRET --name work

# verify current login
splitwise-cli login whoami

# common commands
splitwise-cli friends list
splitwise-cli groups list
splitwise-cli expenses list --from -30d --all
```

Configuration is stored under `~/.splitwise-cli/`.

## Supported Areas

| Area | Summary | Commands | Jump |
|---|---|---|---|
| Login | Manage multiple login credentials and inspect current user | `token`, `oauth`, `list`, `status`, `select`, `default`, `remove`, `validate`, `whoami` | [Login](#login) |
| Friends | List friends and balances | `list` | [Friends](#friends) |
| Groups | List groups and fetch group details | `list`, `get` | [Groups](#groups) |
| Expenses | Query expenses with date/person/group filters | `list`, `get` | [Expenses](#expenses) |
| Profiles | Manage profile restrictions, active profile, and lock state | `list`, `show`, `create`, `edit`, `select`, `remove`, `validate`, `lock` | [Profiles](#profiles) |
| Cache | Export immutable snapshots and inspect offline cache state | `export`, `list`, `refresh`, `status` | [Cache & Offline](#cache--offline) |
| Skills | List/install/create assistant skill files | `list`, `path`, `install`, `create` | [Skills](#skills) |

For global log flags, output streams, and debug behavior, see [Console Logging](#console-logging).

Global profile selection:

- `-p, --profile <name>` selects a profile for the current command.
- If the active profile is locked, switching profiles is blocked until the profile file is edited manually.

Global credential selection:

- `-c, --credential <name>` selects a credential for the current command.
- Resolution order: explicit `--credential` -> profile credential -> active login credential -> default login credential.

Global offline selection:

- `--offline` forces cache-only reads and prevents network access.
- Resolution order: explicit `--offline` -> profile `offlineEnabled` -> online by default.

## Output Formats

Use `-o` / `--output` when available.

| Format | Use case |
|---|---|
| `table` | default terminal view |
| `json` | scripts, pipes, automation |
| `yaml` | readable structured output |

When `--output` is omitted, commands run in TUI mode by default (readable table layout with an intro line, title-cased headers, and a single summary footer line with items/time/source).

```bash
splitwise-cli friends list -o yaml
splitwise-cli expenses list --from -7d -o json
```

## Login

Create login credentials at [splitwise.com/apps/register](https://www.splitwise.com/apps/register).

### Commands

```bash
splitwise-cli login token YOUR_TOKEN --name personal
splitwise-cli login oauth YOUR_KEY YOUR_SECRET --name work
splitwise-cli login list
splitwise-cli login status
splitwise-cli login select work
splitwise-cli login default personal
splitwise-cli login validate work
splitwise-cli login whoami
splitwise-cli login whoami -o json
```

### Example Response (`login whoami -o json`)

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
Showing friends and balances

Id         Name            Balance
────────   ─────────────   ─────────────
11111111   Alice Example   -12.40 USD
22222222   Bob Example     settled up

• 2 item(s) | 43 ms | source: Splitwise API
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

## Groups

### Commands

```bash
splitwise-cli groups list
splitwise-cli groups get <groupId>
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
Showing expenses from 2026-06-01 to 2026-06-13

ID         Date         Group/Friend   Paid By       Description              Costs      Category   Share
────────   ──────────   ────────────   ───────────   ───────────────────────  ─────────  ────────   ───────────
99999      6/10/2026    Flatmates      Alex Example  Groceries                48.90 USD  Food       24.45 USD
99998      6/09/2026    Flatmates      Alex Example  Rent transfer -> Jo      650.00 USD Payment    325.00 USD

• 2 item(s) | 71 ms | source: Splitwise API
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

## Profiles

Profiles control what the CLI is allowed to do and can optionally bind a credential name.

Restriction semantics:

- `limitExpensesToGroupIds` / `limitExpensesToFriendIds` omitted or `null`: unrestricted
- `[]`: nobody allowed
- `[id1, id2, ...]`: only listed ids are allowed

Lock behavior:

- `profiles lock` is one-way from the CLI (no unlock command)
- lock confirmation is interactive in default TUI mode
- in explicit output mode, pass `--yes` to confirm lock
- when locked, login updates and profile/credential switching are blocked

### Commands

```bash
splitwise-cli profiles list
splitwise-cli profiles show default
splitwise-cli profiles create work --create-expenses no --profile-credential personal
splitwise-cli profiles edit work --limit-expenses-to-groups Flatmates,12345 --profile-credential work
splitwise-cli profiles select work
splitwise-cli profiles validate work
splitwise-cli profiles lock work
```

### Core Options (`profiles create|edit`)

| Flag | Description |
|---|---|
| `--create-expenses <yes|no>` | allow/disallow creating expenses |
| `--update-expenses <yes|no>` | allow/disallow updating expenses |
| `--delete-expenses <yes|no>` | allow/disallow deleting expenses |
| `--limit-expenses-to-groups <items>` | comma-separated ids/names, `none` for empty list, `null` for unrestricted |
| `--limit-expenses-to-friends <items>` | comma-separated ids/names, `none` for empty list, `null` for unrestricted |
| `--clear-expense-group-limit` | set expense group limit to unrestricted (`null`) |
| `--clear-expense-friend-limit` | set expense friend limit to unrestricted (`null`) |
| `--profile-credential <name>` | bind a profile to a credential |
| `--clear-profile-credential` | remove profile credential binding |
| `--offline-enabled <yes|no>` | enable cache-only mode by default for this profile |
| `--preferred-cache-target <target>` | preferred cache target: `local`, `user`, `global` |
| `--clear-preferred-cache-target` | clear profile cache target preference |
| `--api-endpoint <url>` | override the Splitwise API base URL |
| `--clear-api-endpoint` | clear the API endpoint override |

### Lock Recovery

When a profile is locked and an operation is blocked, the CLI prints the exact profile file path.
To recover, edit that file and set `"locked": false`, or remove the file manually.

## Cache & Offline

Use the `cache` command group to export immutable local snapshots and query data offline.

### Cache Targets

- `local`: workspace-local cache under the current working directory
- `user`: cache under `~/.splitwise-cli/cache`
- `global`: appdata-based cache area

### Commands

```bash
splitwise-cli cache add expenses --from -30d --target local
splitwise-cli cache add lookup --target user
splitwise-cli cache refresh expenses --target local
splitwise-cli cache delete 01hzzzzzzzzzzzzzzzzzzzzzzz --target local
splitwise-cli cache delete --all --target local
splitwise-cli cache list --target local
splitwise-cli cache status --target local
```

`cache add` and `cache refresh` create immutable cache directories. Writes are staged into temporary cache folders and finalized by rename, so incomplete exports are not exposed as valid cache snapshots.

### Offline Workflow

```bash
# add while online
splitwise-cli cache add all --target local

# read from cache only
splitwise-cli --offline expenses list --from -30d --all
splitwise-cli --offline friends list
splitwise-cli --offline groups list
```

Offline behavior:

- no HTTP requests are made when `--offline` is effective
- partial expense coverage returns available rows plus warnings for uncovered date ranges
- missing expense cache produces an actionable error with an example `cache add` command

### Coverage and Refresh

- `cache list` includes expense coverage windows and a derived coverage status
- `cache refresh expenses` reuses the latest compatible scope for the same account/profile
- refresh prefers both `created_at` and `updated_at` cursors when available and falls back to a bounded overlap window when they are not

### Notes

- `lookup` is stored as separate `categories` and `currencies` entities
- expense exports also persist comments and a lightweight groups snapshot for offline name resolution

## Skills

Built-in skills are copied into the package and can be installed for supported assistants.

### Built-in Skill Names

- `splitwise-cli`
- `splitwise-login`
- `splitwise-expenses`
- `splitwise-groups`
- `splitwise-friends`
- `splitwise-profiles`

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

## Console Logging

Logging and progress output are powered by `consola`.

Global logging controls:

| Flag | Description |
|---|---|
| `--log <level>` | explicit level: `error`, `warn`, `info`, `debug`, `trace` |
| `-v` | increase verbosity (`-v`, `-vv`, `-vvv`, `-vvvv`) |

Environment override:

- `SW_DEBUG=1|yes|true` forces trace-level logging in all modes.

Stream contract:

- Structured payloads (`-o json`, `-o yaml`) are printed to `stdout`.
- Logs, warnings, errors, and progress/status text are printed to `stderr`.

HTTP client logging:

- Request/response lifecycle logs include method, URL, status code, duration, and attempt.
- Error logs include method, URL, duration, and error message.
- Headers and response/request content are intentionally not logged.

Cache/offline diagnostics:

- add and refresh operations emit cache diagnostics under the `cache` tag
- debug/trace logging includes refresh strategy and staged batch lifecycle details
- offline expense warnings are emitted to `stderr` so structured output remains machine-readable

Color behavior:

- Colored logs are shown only in table/TUI mode.
- JSON and YAML modes keep logs uncolored to stay script-friendly.

Icons and progress indicators:

- In TUI/table mode, status lines are icon-first (for example info/success) without the `INFO` text label.
- TUI progress uses an animated spinner on supported terminals.
- Progress completion uses a success icon when done and an error icon when failed.
- On minimal terminals, icon/spinner output falls back to ASCII-safe symbols.

Examples:

```bash
splitwise-cli friends list --log info
splitwise-cli expenses list -vv --from -30d
SW_DEBUG=true splitwise-cli groups get 12345 -o json
```

## Development

```bash
npm install
npm run build
npm run dev -- expenses list --from -7d
```

Packaging workflow:

- `npm run build` compiles TypeScript only (fast local validation, no skill copy).
- `npm run build:package` compiles, copies skills to `dist/skills`, and syncs skill metadata version to `package.json`.
- `npm pack` and `npm publish` run `prepack` automatically, so published tarballs always contain versioned skills.
- `npm run release` is a convenience wrapper for `npm publish`.
