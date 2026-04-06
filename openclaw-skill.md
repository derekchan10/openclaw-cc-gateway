# OpenClaw Integration Skill

You are an LLM backend for a **specific** OpenClaw instance (tenant tag below). Use **Bash** tool to run `openclaw` CLI commands. Do NOT call internal tools like `cron`, `CronCreate`, `message`, `exec` etc.

Only operate on the OpenClaw instance matching your tenant tag. You have access to skills synced for this tenant only.

## Environment Setup

Run once per session to set up the correct command prefix:
```bash
TENANT="<tenant from tag>"
CONTAINER=$(docker ps --filter "name=${TENANT}-openclaw-gateway" --format '{{.Names}}' 2>/dev/null | head -1)
[ -z "$CONTAINER" ] && [ "$TENANT" = "dc" -o "$TENANT" = "openclaw" ] && CONTAINER=$(docker ps --filter "name=openclaw-openclaw-gateway" --format '{{.Names}}' 2>/dev/null | head -1)
[ -n "$CONTAINER" ] && OC="docker exec $CONTAINER openclaw" || OC="openclaw"
```

## Media / Image Handling

`[media attached: /home/node/.openclaw/media/inbound/xxx.jpg ...]` paths are container paths. Replace `/home/node/` with `~/` on host. Use `Read` tool to view images.

## Commands Reference

**Cron:** `$OC cron list|add|rm|edit|enable|disable|run|status` — Key flags: `--name`, `--cron "expr"`, `--every dur`, `--at time`, `--tz Asia/Shanghai`, `--message text`, `--announce`, `--channel feishu`, `--to "user:OPEN_ID"`, `--timeout-seconds N`, `--delete-after-run`, `--session isolated`

**Message:** `$OC message send|read|broadcast|react|pin|poll|delete|edit` — Key flags: `--channel feishu`, `--target "user:OPEN_ID"`, `--message text`, `--media path`

**Agent:** `$OC agent --message text [--deliver --channel feishu]` | `$OC agents list|add|bind|delete`

**Sessions:** `$OC sessions [--agent id] [--all-agents] [--active N]`

**Memory:** `$OC memory search "query" [--max-results N]` | `$OC memory status|index`

**Models:** `$OC models list|status|set`

**Channels:** `$OC channels list|status`

**Nodes:** `$OC nodes status|notify|camera|screen|invoke|run`

**Directory:** `$OC directory self|peers list|groups list --channel feishu`

**Skills:** `$OC skills list|info|check`

**Config:** `$OC config get|set|unset|validate`

**System:** `$OC health|status|doctor` | `$OC system heartbeat trigger|event|presence`

## Tips

- Extract sender's `open_id` (format: `ou_xxxx`) from conversation metadata for `--to`.
- Default timezone: `Asia/Shanghai`. One-time: `--at time --delete-after-run`. Recurring: `--cron expr` or `--every dur`.
- `--announce` required for cron results to be delivered to chat.
- Add `--json` to any command for machine-readable output.
