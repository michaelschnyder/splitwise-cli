---
name: splitwise-login
description: Manage splitwise-cli login credentials and troubleshoot access issues.
metadata:
  version: "1.2.4"
  author: splitwise-cli
  tags: splitwise,login,oauth,token,credentials
  alwaysApply: "false"
---

# Splitwise Login

Manage named Splitwise CLI credentials and verify active identity.

## Quick Reference

| Task | Command |
|------|---------|
| Save access token | `splitwise-cli login token <token> --name <name>` |
| Save OAuth key/secret | `splitwise-cli login oauth <consumerKey> <consumerSecret> --name <name>` |
| List credentials | `splitwise-cli login list` |
| Show selected credential | `splitwise-cli login status` |
| Switch active credential | `splitwise-cli login select <name>` |
| Validate credential | `splitwise-cli login validate <name>` |
| Verify identity | `splitwise-cli login whoami` |
| Verify identity (JSON) | `splitwise-cli login whoami -o json` |

## Commands

~~~bash
splitwise-cli login token <token> --name personal
splitwise-cli login oauth <consumerKey> <consumerSecret> --name work
splitwise-cli login list
splitwise-cli login status
splitwise-cli login validate personal
splitwise-cli login whoami -o json
~~~

## Logging and Debug

- Use `--log <level>` (`error|warn|info|debug|trace`) for explicit logging.
- Use `-v/-vv/-vvv/-vvvv` for verbosity shorthand.
- Set `SW_DEBUG=1|yes|true` to force trace logs.
- In `-o json` mode, payload stays on stdout and logs go to stderr.

## Typical Workflow

~~~bash
splitwise-cli login token <token> --name personal
splitwise-cli login select personal
splitwise-cli login whoami
splitwise-cli friends list
~~~

## Credential Resolution

Runtime credential selection uses this order:

1. explicit global `--credential <name>`
2. profile-bound credential (`profiles create|edit --profile-credential <name>`)
3. selected active credential (`login select <name>`)
4. default credential (`login default <name>`)

## Profiles Interaction

- Credentials are stored globally in config and can be referenced by profiles.
- If the active profile is locked, login mutations and profile/credential switching are blocked.
- Lock recovery is manual by editing/removing the locked profile file path printed by the CLI.

## Storage

Credentials are stored in:

- `~/.splitwise-cli/config.json`

## Troubleshooting

- If commands fail with login errors, run `splitwise-cli login status` then refresh credentials.
- Credentials are stored at ~/.splitwise-cli/config.json.
- Prefer `splitwise-cli login whoami` to verify identity before other operations.

## Failure Handling

| Problem | Cause | Fix |
|---|---|---|
| `Not logged in` | No credential available after precedence resolution | Create one with `login token` or `login oauth` |
| `login whoami` fails | Invalid/expired token | Re-issue and update with `login token` |
| 401/403 from other commands | Active credential no longer valid | Confirm with `login whoami`, then refresh credential |

## Command Discovery

~~~bash
splitwise-cli login --help
splitwise-cli login whoami --help
~~~
