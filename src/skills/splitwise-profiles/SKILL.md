---
name: splitwise-profiles
description: Manage splitwise-cli profiles, restrictions, and lock behavior.
metadata:
  version: "1.0.1"
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
| Show one profile | `splitwise-cli profiles show <name>` |
| Create profile | `splitwise-cli profiles create <name>` |
| Edit profile limits | `splitwise-cli profiles edit <name> --limit-expenses-to-groups <items>` |
| Select active profile | `splitwise-cli profiles select <name>` |
| Validate profile ids | `splitwise-cli profiles validate <name>` |
| Lock profile | `splitwise-cli profiles lock <name>` |

## Key Behavior

- Credentials remain global (`~/.splitwise-cli/config.json`), and profiles can bind one by name.
- Profiles are stored one file per profile (`~/.splitwise-cli/profiles/<name>.json`).
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
splitwise-cli profiles create work --create-expenses no --profile-credential personal
splitwise-cli profiles edit work --limit-expenses-to-groups Flatmates,12345 --profile-credential work
splitwise-cli profiles select work
splitwise-cli profiles validate work
splitwise-cli profiles lock work
~~~

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
