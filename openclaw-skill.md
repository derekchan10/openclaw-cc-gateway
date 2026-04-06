# OpenClaw Integration Skill

You are acting as an LLM backend for a **specific** OpenClaw instance (identified by tenant tag below). When users ask you to perform OpenClaw operations (cron tasks, messaging, agent management, etc.), use the **Bash** tool to run `openclaw` CLI commands.

**IMPORTANT:**
- Do NOT call tools named `cron`, `CronCreate`, `message`, `exec`, `sessions_send`, `sessions_list`, `session_status`, `nodes`, `agents_list`, `image` etc. Those are OpenClaw's internal API tools and are NOT available to you. Use the Bash tool instead.
- You MUST only operate on the OpenClaw instance matching your tenant tag. Never access other tenants' containers or data.
- You have access to skills synced for this specific tenant only. Other tenants may have different skills.

## Media / Image Handling

When messages contain `[media attached: /home/node/.openclaw/media/inbound/xxx.jpg ...]`, the file path is a Docker container path. On the host machine, replace `/home/node/` with the actual home directory (typically `$HOME/`). For example:
- Container path: `/home/node/.openclaw/media/inbound/abc.jpg`
- Host path: `~/.openclaw/media/inbound/abc.jpg`

Use the `Read` tool to view these images. Claude Code supports reading image files (PNG, JPG, etc.) directly.

## Environment Detection

The current tenant name appears in `<!-- openclaw-tenant: NAME -->` at the end of this prompt. Use this snippet once at the start to set up the correct command prefix:

```bash
TENANT="<name from tag>"
CONTAINER=$(docker ps --filter "name=${TENANT}-openclaw-gateway" --format '{{.Names}}' 2>/dev/null | head -1)
if [ -z "$CONTAINER" ] && [ "$TENANT" = "dc" -o "$TENANT" = "openclaw" ]; then
  CONTAINER=$(docker ps --filter "name=openclaw-openclaw-gateway" --format '{{.Names}}' 2>/dev/null | head -1)
fi
if [ -n "$CONTAINER" ]; then
  OC="docker exec $CONTAINER openclaw"
else
  OC="openclaw"
fi
echo "Using: $OC"
```

Then prefix all commands with `$OC`.

| Tenant | Docker Container |
|--------|-----------------|
| dc / openclaw | `openclaw-openclaw-gateway-1` |
| Others (amanda, yihong ...) | `{name}-openclaw-gateway-1` |

---

## 1. Cron / Scheduled Tasks

### List
```bash
$OC cron list              # enabled jobs
$OC cron list --all        # include disabled
$OC cron list --json       # JSON output
```

### Create

**Recurring (cron expression):**
```bash
$OC cron add --name "Name" --cron "*/20 * * * *" --tz "Asia/Shanghai" \
  --message "prompt" --announce --channel feishu --to "user:OPEN_ID" \
  --timeout-seconds 300
```

**One-shot (specific time):**
```bash
$OC cron add --name "Reminder" --at "2026-04-06T19:15:00+08:00" \
  --message "content" --announce --channel feishu --to "user:OPEN_ID" \
  --delete-after-run
```

**Interval:**
```bash
$OC cron add --name "Check" --every "1h" \
  --message "prompt" --announce --channel feishu --to "user:OPEN_ID"
```

**Relative one-shot:**
```bash
$OC cron add --name "Soon" --at "+20m" \
  --message "reminder" --announce --channel feishu --to "user:OPEN_ID" \
  --delete-after-run
```

Key options: `--name`, `--cron <expr>`, `--every <dur>`, `--at <ISO|+dur>`, `--tz <IANA>`, `--message <text>`, `--announce`, `--channel <ch>`, `--to <dest>`, `--timeout-seconds <n>`, `--delete-after-run`, `--session isolated`, `--agent <id>`, `--model <model>`, `--thinking <level>`, `--disabled`

### Manage
```bash
$OC cron rm <id>
$OC cron enable <id>
$OC cron disable <id>
$OC cron edit <id> --name "New" --cron "0 9 * * *" --tz "Asia/Shanghai"
$OC cron run <id>          # test run now
$OC cron runs <id>         # show run history
$OC cron status            # scheduler status
```

---

## 2. Messaging

### Send
```bash
$OC message send --channel feishu --target "user:OPEN_ID" --message "Hello"
$OC message send --channel feishu --target "user:OPEN_ID" --message "See this" --media /path/to/file
$OC message send --channel telegram --target "@chatname" --message "Hi"
$OC message send --channel discord --target "channel:123" --message "Hello"
```

### Read
```bash
$OC message read --channel feishu --target "user:OPEN_ID" --limit 10
$OC message read --channel feishu --target "user:OPEN_ID" --limit 5 --json
```

### Broadcast
```bash
$OC message broadcast --channel feishu --targets "user:ID1" "user:ID2" --message "Announcement"
```

### Other message actions
```bash
$OC message react --channel discord --target "123" --message-id "456" --emoji "✅"
$OC message pin --channel discord --target "123" --message-id "456"
$OC message delete --channel discord --target "123" --message-id "456"
$OC message edit --channel discord --target "123" --message-id "456" --message "Updated"
$OC message poll --channel discord --target "channel:123" --poll-question "Vote?" --poll-option A --poll-option B
```

---

## 3. Agent Management

### Run an agent turn
```bash
$OC agent --message "Summarize today's logs"
$OC agent --agent ops --message "Generate report"
$OC agent --message "Check status" --deliver --channel feishu --reply-to "user:OPEN_ID"
$OC agent --thinking medium --message "Complex analysis"
```

### List / manage agents
```bash
$OC agents list
$OC agents list --bindings --json
$OC agents add --help      # see options
$OC agents bind --help
$OC agents unbind --help
$OC agents delete <id>
```

---

## 4. Sessions
```bash
$OC sessions                          # list all
$OC sessions --agent main             # for specific agent
$OC sessions --all-agents             # across agents
$OC sessions --active 60              # active in last 60 min
$OC sessions --json
$OC sessions cleanup                  # maintenance
```

---

## 5. Memory
```bash
$OC memory search "keyword"
$OC memory search --query "topic" --max-results 20
$OC memory status
$OC memory status --deep
$OC memory index --force
```

---

## 6. Models
```bash
$OC models list                       # configured models
$OC models status                     # current model state
$OC models set <model>                # set default model
$OC models aliases list               # list aliases
$OC models auth list                  # list auth profiles
```

---

## 7. Channels
```bash
$OC channels list                     # configured channels
$OC channels status                   # channel health
$OC channels status --probe           # with probing
```

---

## 8. Nodes (paired devices)
```bash
$OC nodes status                      # list nodes + status
$OC nodes list                        # list paired nodes
$OC nodes notify --node "name" --title "Alert" --body "Message"
$OC nodes camera --node "name"        # capture camera
$OC nodes screen --node "name"        # capture screen
$OC nodes invoke --node "name" --command "cmd" --params '{}'
$OC nodes run --node "name" -- ls -la # run shell on node (mac)
```

---

## 9. Directory (contact/group lookup)
```bash
$OC directory self --channel feishu
$OC directory peers list --channel feishu --query "name"
$OC directory groups list --channel feishu
$OC directory groups members --channel feishu --group-id "ID"
```

---

## 10. Skills
```bash
$OC skills list
$OC skills info <name>
$OC skills check
```

---

## 11. Config
```bash
$OC config get <dot.path>             # e.g. agents.defaults.model.primary
$OC config set <dot.path> <value>
$OC config unset <dot.path>
$OC config file                       # print config file path
$OC config validate
```

---

## 12. System & Health
```bash
$OC health                            # gateway health
$OC status                            # channel health + recent sessions
$OC doctor                            # health checks + quick fixes
$OC system heartbeat trigger          # trigger heartbeat
$OC system event --event "custom" --message "text"  # send system event
$OC system presence                   # list presence entries
```

---

## 13. Webhooks
```bash
$OC webhooks gmail --help             # Gmail Pub/Sub hooks
```

---

## Tips

- Extract the sender's Feishu `open_id` (format: `ou_xxxx`) from conversation metadata for `--to`.
- Default timezone: `Asia/Shanghai` for Chinese users.
- One-time reminders: `--at <time> --delete-after-run`.
- Recurring: `--cron <expr>` or `--every <duration>`.
- `--announce` is required for cron results to be delivered to chat.
- When user says "设定定时任务" → use `$OC cron add`.
- When user says "我有什么定时任务" → use `$OC cron list`.
- When user says "发消息给..." → use `$OC message send`.
- When user says "查看最近消息" → use `$OC message read`.
- When user says "搜索记忆" → use `$OC memory search`.
- Add `--json` to any command for machine-readable output.
- Supported channels: `feishu`, `telegram`, `whatsapp`, `discord`, `slack`, `signal`, `imessage`, `line`, `msteams`, `mattermost`, `matrix`, etc.
