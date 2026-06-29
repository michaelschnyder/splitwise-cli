---
name: splitwise-cache
description: Export, refresh, inspect, and delete Splitwise cache snapshots for offline use.
metadata:
  version: "1.2.1"
  author: splitwise-cli
  tags: splitwise,cache,offline,exports,refresh
  alwaysApply: "false"
---

# Splitwise Cache

Use this skill when you need immutable Splitwise cache snapshots, offline reads, or cache coverage diagnostics.

## Quick Reference

| Task | Command |
|------|---------|
| Add cached expenses | `splitwise-cli cache add expenses --from -30d` |
| Add all cache entities | `splitwise-cli cache add all` |
| Refresh expenses cache | `splitwise-cli cache refresh expenses` |
| List cache entries | `splitwise-cli cache list` |
| Show cache status | `splitwise-cli cache status` |
| Delete one cache id | `splitwise-cli cache delete <id>` |
| Delete all cache data | `splitwise-cli cache delete --all` |

## Cache Targets

- `local`: workspace-local cache under the current working directory
- `user`: cache under `~/.splitwise-cli/cache`
- `global`: appdata-based cache area

## Commands

~~~bash
splitwise-cli cache add expenses --from -30d --target local
splitwise-cli cache add lookup
splitwise-cli cache add lookup --target user
splitwise-cli cache refresh expenses
splitwise-cli cache delete <id>
splitwise-cli cache delete --all
splitwise-cli cache list
splitwise-cli cache status
~~~

## Offline Workflow

~~~bash
# add while online
splitwise-cli cache add all

# read from cache only
splitwise-cli --offline expenses list --from -30d --all
splitwise-cli --offline friends list
splitwise-cli --offline groups list
~~~

Offline behavior:

- no HTTP requests are made when `--offline` is effective
- partial expense coverage returns available rows plus warnings for uncovered date ranges
- missing expense cache produces an actionable error with an example `cache add` command

## Coverage and Refresh

- `cache list` includes expense coverage windows and a derived coverage status
- `cache refresh expenses` reuses the latest compatible scope for the same account and profile
- refresh prefers both `created_at` and `updated_at` cursors when available and falls back to a bounded overlap window when they are not

## Notes

- `lookup` is stored as separate `categories` and `currencies` entities
- `comments` can be exported and refreshed independently from `expenses`
- expense exports still persist a lightweight groups snapshot for offline name resolution
- `cache add` and `cache refresh` create immutable cache directories

## Command Discovery

~~~bash
splitwise-cli cache --help
splitwise-cli cache add --help
splitwise-cli cache refresh --help
~~~
