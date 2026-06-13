---
name: splitwise-auth
description: Authenticate splitwise-cli and troubleshoot access issues.
metadata:
  version: "1.0.1"
  author: splitwise-cli
  tags: splitwise,auth,oauth,token
  alwaysApply: "false"
---

# Splitwise Authentication

Manage Splitwise CLI credentials and verify active identity.

## Quick Reference

| Task | Command |
|------|---------|
| Save access token | `splitwise-cli auth set-token <token>` |
| Save OAuth key/secret | `splitwise-cli auth set-oauth <consumerKey> <consumerSecret>` |
| Verify identity | `splitwise-cli auth whoami` |
| Verify identity (JSON) | `splitwise-cli auth whoami -o json` |

## Commands

~~~bash
splitwise-cli auth set-token <token>
splitwise-cli auth set-oauth <consumerKey> <consumerSecret>
splitwise-cli auth whoami -o json
~~~

## Logging and Debug

- Use `--log <level>` (`error|warn|info|debug|trace`) for explicit logging.
- Use `-v/-vv/-vvv/-vvvv` for verbosity shorthand.
- Set `SW_DEBUG=1|yes|true` to force trace logs.
- In `-o json` mode, payload stays on stdout and logs go to stderr.

## Typical Workflow

~~~bash
splitwise-cli auth set-token <token>
splitwise-cli auth whoami
splitwise-cli friends list
~~~

## Credential Priority

`set-token` and `set-oauth` are mutually exclusive in config:

- Setting a token removes stored OAuth key/secret.
- Setting OAuth credentials removes stored token.

## Profiles Interaction

- Credentials are global and not stored inside profiles.
- If the active profile is locked, `auth set-token` and `auth set-oauth` are blocked.
- Lock recovery is manual by editing/removing the locked profile file path printed by the CLI.

## Storage

Credentials are stored in:

- `~/.splitwise-cli/config.json`

## Troubleshooting

- If commands fail with authentication errors, re-run auth set-token.
- Credentials are stored at ~/.splitwise-cli/config.json.
- Prefer auth whoami to verify identity before other operations.

## Failure Handling

| Problem | Cause | Fix |
|---|---|---|
| `Not authenticated` | No token or OAuth credentials saved | Save credentials with `set-token` or `set-oauth` |
| `auth whoami` fails | Invalid/expired token | Re-issue token and run `set-token` again |
| 401/403 from other commands | Auth no longer valid | Confirm with `auth whoami`, then re-authenticate |

## Command Discovery

~~~bash
splitwise-cli auth --help
splitwise-cli auth whoami --help
~~~
