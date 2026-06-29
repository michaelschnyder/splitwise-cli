---
name: splitwise-profiles
description: Manage splitwise-cli profiles, restrictions, and lock behavior.
metadata:
  version: "1.2.3"
  author: splitwise-cli
  tags: splitwise,profiles,restrictions,lock
  alwaysApply: "false"
---

# Splitwise Profiles

Use this skill when you need to manage profile-based restrictions in splitwise-cli.

## Quick Reference

| Task | Command |
|------|---------|
| List profiles | `splitwise-cli profiles list` |
| Show active profile | `splitwise-cli profiles show default` |
| Create profile | `splitwise-cli profiles create <name>` |
| Edit profile limits | `splitwise-cli profiles edit <name> --limit-expenses-to-groups Flatmates,12345` |
| Bind a credential | `splitwise-cli profiles edit <name> --profile-credential <name>` |
| Set offline default | `splitwise-cli profiles edit <name> --offline-enabled yes` |
| Set cache target | `splitwise-cli profiles edit <name> --preferred-cache-target local` |
| Override API base URL | `splitwise-cli profiles edit <name> --api-endpoint <url>` |
| Select active profile | `splitwise-cli profiles select <name>` |
| Validate profile ids | `splitwise-cli profiles validate <name>` |
| Lock profile | `splitwise-cli profiles lock <name>` |

## Key Behavior

- Credentials remain global (`~/.splitwise-cli/config.json`), and profiles can bind one by name.
- Profiles are stored one file per profile (`~/.splitwise-cli/profiles/<name>.json`).
- Profiles can default offline mode, choose a preferred cache target, and override the API endpoint.
- Restriction semantics:
  - missing/null restriction field => unrestricted
  - empty list => allow nobody
  - non-empty list => allow listed ids only
- Lock is one-way from CLI. There is no unlock command.
- Credential resolution order is: `--credential` -> profile credential -> active credential -> default credential.

## Commands

~~~bash
splitwise-cli profiles list
splitwise-cli profiles show default
splitwise-cli profiles create work
splitwise-cli profiles edit work --limit-expenses-to-groups Flatmates,12345
splitwise-cli profiles select work
splitwise-cli profiles validate work
splitwise-cli profiles lock work
~~~

## Restriction Examples

~~~bash
splitwise-cli profiles edit work --limit-expenses-to-groups Flatmates,12345
splitwise-cli profiles edit work --limit-expenses-to-friends Alice,67890
splitwise-cli profiles edit work --limit-expenses-to-groups none
splitwise-cli profiles edit work --limit-expenses-to-friends null
~~~

## Supported Edit Flags

- `--create-expenses <yes-or-no>`
- `--update-expenses <yes-or-no>`
- `--delete-expenses <yes-or-no>`
- `--offline-enabled <yes-or-no>`
- `--limit-expenses-to-groups <items>`
- `--limit-expenses-to-friends <items>`
- `--clear-expense-group-limit`
- `--clear-expense-friend-limit`
- `--profile-credential <name>`
- `--clear-profile-credential`
- `--preferred-cache-target <target>`
- `--clear-preferred-cache-target`
- `--api-endpoint <url>`
- `--clear-api-endpoint`

## Lock Recovery

When a profile is locked, blocked actions print the profile file path.
To recover manually:

1. Edit the profile file and set `"locked": false`, or
2. Remove the profile file.

## Command Discovery

~~~bash
splitwise-cli profiles --help
splitwise-cli profiles edit --help
~~~
