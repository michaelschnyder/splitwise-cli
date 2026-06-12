---
name: splitwise-auth
description: Authenticate splitwise-cli and troubleshoot access issues.
metadata:
  version: "1.0.0"
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
