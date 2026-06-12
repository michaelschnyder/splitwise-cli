# :money_with_wings: Give Your Agent a Receipt Book: Introducing splitwise-cli

A practical command-line companion for Splitwise that is optimized for both humans and coding agents.

Track expenses, filter by people and groups, and export structured results fast enough for scripts, dashboards, and AI workflows.

## Why This Exists

Splitwise already has great APIs. This CLI makes them pleasant to use in terminal-first workflows:

- Fast commands for daily finance operations
- Consistent table, JSON, and YAML output
- Name-based filters that resolve to API IDs automatically
- Agent-ready skills that can be installed into coding assistants

This project uses the `splitwise` Node.js library for Splitwise API integration.

## Quick Start

~~~bash
# install globally from npm
npm install -g splitwise-cli

# or run directly with npx
npx splitwise-cli auth whoami

# authenticate
splitwise-cli auth set-token YOUR_TOKEN

# run common commands
splitwise-cli auth whoami
splitwise-cli groups list
splitwise-cli expenses list --from -30d --all
~~~

## Installation

### npm (Global Install)

~~~bash
npm install -g splitwise-cli
~~~

### npx (No Global Install)

~~~bash
npx splitwise-cli --help
npx splitwise-cli auth whoami
~~~

### Local Development (Clone)

~~~bash
git clone <repo>
cd splitwise-cli
npm install
npm run dev -- expenses list --from -7d
~~~

### Local Build + Local Global Install

~~~bash
npm run build
npm install -g .
~~~

### Verify

~~~bash
splitwise-cli --version
splitwise-cli auth whoami
~~~

## Authentication

Get credentials from https://www.splitwise.com/apps/register.

~~~bash
# token mode
splitwise-cli auth set-token YOUR_TOKEN

# oauth client credentials mode
splitwise-cli auth set-oauth YOUR_KEY YOUR_SECRET

# verify active identity
splitwise-cli auth whoami
splitwise-cli auth whoami -o json
~~~

Credentials are written to ~/.splitwise-cli/config.json.

## Output Formats

Use -o or --output on commands that return structured data.

| Format | Purpose |
|---|---|
| table | Human-readable terminal view (default) |
| json | Script-friendly structured output |
| yaml | Readable structured output with comments-friendly style |

~~~bash
splitwise-cli friends list -o yaml
splitwise-cli expenses list -o json
~~~

## Command Overview

| Domain | Commands |
|---|---|
| auth | set-token, set-oauth, whoami |
| friends | list |
| groups | list, get |
| expenses | list, get |
| skills | list, install, path, create |

## Expenses Deep Dive

### List

~~~bash
splitwise-cli expenses list [options]
~~~

### Options

| Flag | Short | Description |
|---|---|---|
| --group <id|name> | -g | Filter by group ID or partial group name |
| --friend <id|name> | -u | Filter by friend ID or partial friend name |
| --from <date> | -f | Include expenses on or after date |
| --to <date> |  | Include expenses on or before date |
| --max <n> | -m | Max number of returned records when not using --all |
| --all |  | Walk all pages |
| --mine |  | Equivalent to --payer @me |
| --involved <@me|id|name> |  | Client-side participant filter |
| --payer <@me|id|name> |  | Client-side payer filter |
| --query <string> |  | Shorthand key:value tokens |
| --output <format> | -o | table, json, yaml |

### Date Formats

Both --from and --to support:

- ISO date: 2026-01-01
- Relative values: -10d, -2w, -1month, -1y

~~~bash
splitwise-cli expenses list --from -30d
splitwise-cli expenses list --from 2026-01-01 --to 2026-12-31
~~~

### Query Shorthand

The --query flag supports key:value tokens:

- group:
- friend:
- from:
- to:

Explicit flags win over matching query tokens.

~~~bash
splitwise-cli expenses list --query "friend:Alice group:Flatmates from:-30d"
splitwise-cli expenses list --query "group:flat from:-7d" --group "Other Group"
~~~

### Server-Side vs Client-Side Filters

| Filter | Execution |
|---|---|
| --group | Server-side after local name resolution |
| --friend | Server-side after local name resolution |
| --from / --to | Server-side |
| --involved | Client-side |
| --payer / --mine | Client-side |

### Get One Expense

~~~bash
splitwise-cli expenses get 12345
splitwise-cli expenses get 12345 -o yaml
~~~

## Practical Examples

~~~bash
# all expenses in last 30 days as JSON
splitwise-cli expenses list --from -30d --all -o json

# expenses where current user paid in a group
splitwise-cli expenses list --group Flatmates --mine --from -1month

# expenses where a specific user is involved
splitwise-cli expenses list --involved Alice --from -14d -o table

# inspect one expense with split details and comments
splitwise-cli expenses get 99999 -o json
~~~

## Agent Skills

Splitwise CLI ships embedded skills as packaged resources: they are stored in source, copied into the build output, and installed by command.

### Built-In Skills

- splitwise-cli
- splitwise-auth
- splitwise-expenses
- splitwise-groups
- splitwise-friends

### Resource Layout

- source resources: src/skills/<skill>/SKILL.md
- packaged resources: dist/skills/<skill>/SKILL.md

### List Skills

~~~bash
splitwise-cli skills list
splitwise-cli skills list -o json
~~~

### Install Skills

~~~bash
# auto-detect platform
splitwise-cli skills install

# explicit platform
splitwise-cli skills install claude

# project-local install
splitwise-cli skills install codex --project

# install one skill only
splitwise-cli skills install cursor --name splitwise-expenses

# install to all supported platforms
splitwise-cli skills install all
~~~

Supported platform values:

- claude or claude-code
- cursor
- codex
- opencode
- windsurf
- gemini or gemini-code
- pi
- all

### Show Install Paths

~~~bash
splitwise-cli skills path claude
splitwise-cli skills path all --project
~~~

### Create Skill Files Manually

~~~bash
splitwise-cli skills create
splitwise-cli skills create --name splitwise-expenses
splitwise-cli skills create --dir ./generated-skills --force
~~~

## Development Notes

~~~bash
npm run build      # compiles TS and copies skills to dist/skills
npm run dev -- groups list
~~~
