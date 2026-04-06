# OpenClaw CC Gateway

[![GitHub stars](https://img.shields.io/github/stars/derekchan10/openclaw-cc-gateway?style=social)](https://github.com/derekchan10/openclaw-cc-gateway/stargazers)
[![GitHub license](https://img.shields.io/github/license/derekchan10/openclaw-cc-gateway)](LICENSE)
English | [中文](README_CN.md)

Multi-tenant Claude Code CLI gateway for [OpenClaw](https://github.com/openclaw/openclaw). Bypasses Anthropic's third-party OAuth restrictions by routing LLM requests through the Claude Code CLI subprocess, with per-tenant skill and session isolation.

## Features

- **Anthropic Messages API** (`/v1/messages`) — native format that OpenClaw uses
- **OpenAI Chat API** (`/v1/chat/completions`) — compatibility endpoint
- **Multi-tenant isolation** — per-tenant API keys, sessions, skills, env vars, and concurrency control
- **Auto-discovery** — automatically finds Docker and local OpenClaw instances
- **Auto-setup** — generates config, syncs skills, extracts env vars in one command
- **Per-tenant Skills** — each tenant loads only its own OpenClaw skills (`skills/<tenant>/`)
- **Per-tenant Env Vars** — auto-extracted from each OpenClaw instance's `openclaw.json`
- **OpenClaw Skill Prompt** — teaches Claude CLI to use `openclaw` commands (cron, messaging, etc.)
- **Multi-turn buffering** — CLI executes tools internally, only the final response is returned
- **Streaming SSE** — full Anthropic streaming event passthrough

## How It Works

```
OpenClaw Container (tenant=alice)
  → POST /v1/messages (x-api-key: alice-key)
    → openclaw-cc-gateway
      → authenticate → tenant=alice
      → inject env vars from config.tenants[alice].env
      → load skills from skills/alice/
      → spawn claude CLI subprocess
        → Claude Max subscription (bypasses OAuth restrictions)
      → buffer tool rounds, return final response
    ← Anthropic SSE stream
  ← Agent processes response
```

## Quick Start

### Prerequisites

- Node.js 22+
- Claude Code CLI: `npm install -g @anthropic-ai/claude-code && claude auth login`
- Docker (if using OpenClaw in containers)

### Install & Setup

```bash
git clone <repo-url>
cd openclaw-cc-gateway
npm install
npm run build

# Auto-discover OpenClaw instances, generate config, sync skills
node dist/index.js --setup
```

This will:
1. Detect Docker host IP
2. Discover all running OpenClaw containers
3. Extract env vars from each instance's `openclaw.json`
4. Generate `config.yaml` with API keys and env vars per tenant
5. Update each instance's `openclaw.json` to point to the gateway
6. Sync skills per tenant (`skills/<tenant>/`)

Use `--no-skills` to skip skill sync, or `--skills` to re-sync skills only.

### Start

```bash
npm start

# Or with PM2
pm2 start dist/index.js --name openclaw-cc-gateway
pm2 save
```

## Tenant Management

```bash
# List all tenants
npm run manage list

# Add a new tenant (auto-generates API key)
npm run manage add <name>
npm run manage add <name> --apply        # add + apply to OpenClaw instance

# Remove a tenant
npm run manage remove <name>

# Push config to OpenClaw instance(s)
npm run manage apply                     # all tenants
npm run manage apply <name>              # single tenant

# Generate a random API key
npm run manage gen-key
```

The `apply` command updates:
- Instance's `openclaw.json` (model provider baseUrl + apiKey)
- Instance's `.env` file (ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY)

## Skill Management

Skills are synced **per-tenant** with bidirectional support — each OpenClaw instance gets its own isolated skill directory. When a CLI subprocess runs for a tenant, it only loads skills from `skills/<tenant>/`.

```bash
# List skills from OpenClaw instance(s)
npm run manage skills list               # all tenants
npm run manage skills list <name>        # single tenant

# Pull: OpenClaw → local (download skills from containers)
npm run manage skills pull               # all tenants
npm run manage skills pull <name>        # single tenant

# Push: local → OpenClaw (upload skills to containers)
npm run manage skills push               # all tenants
npm run manage skills push <name>        # single tenant

# Diff: show what's different between local and remote
npm run manage skills diff               # all tenants
npm run manage skills diff <name>        # single tenant

# Bidirectional sync: pull new remote + push new local
npm run manage skills bisync             # all tenants
npm run manage skills bisync <name>      # single tenant
npm run manage skills bisync --pull      # only pull direction
npm run manage skills bisync --push      # only push direction

# Clean synced skills
npm run manage skills clean
```

### Sync Directions

| Command | Direction | What it does |
|---------|-----------|-------------|
| `pull` | OpenClaw → local | Download skills from container to `skills/<tenant>/` |
| `push` | local → OpenClaw | Upload skills from `skills/<tenant>/` to container's `workspace/skills/` |
| `diff` | — | Show which skills exist only locally, only remotely, or both |
| `bisync` | both | Pull new remote skills + push new local skills (no overwrites) |

### Skill Isolation

```
skills/
├── alice/                 ← only loaded for tenant "alice"
│   ├── github/SKILL.md
│   ├── custom-tool/
│   └── ...
├── bob/                   ← only loaded for tenant "bob"
│   ├── github/SKILL.md
│   ├── another-skill/
│   └── ...
└── ...
```

Each tenant's CLI subprocess receives `--add-dir skills/<tenant>/<skill>` for its skills only. Skills from other tenants are never loaded.

## Configuration

### config.yaml

Auto-generated by `--setup`, or create manually from `config.example.yaml`:

```yaml
server:
  port: 3456
  host: "0.0.0.0"
  docker_host_ip: "auto"           # auto-detected, or set DOCKER_HOST_IP env

cli:
  bin: "claude"
  timeout: 900000                   # 15 min per request
  max_concurrent: 3                 # max parallel CLI subprocesses

session:
  ttl: 3600
  cleanup_interval: 900

skills:
  sync: "auto"                     # auto | manual | disabled
  dir: "./skills"                  # per-tenant skill storage

tenants:
  - name: alice
    api_key: "<hex-string>"
    env:                           # auto-extracted from openclaw.json
      MY_API_KEY: "xxx"
      MY_SECRET: "xxx"
  - name: bob
    api_key: "<hex-string>"
```

### Per-Tenant Isolation

| Resource | Isolation |
|----------|-----------|
| **API Key** | Unique per tenant |
| **Sessions** | Namespaced `<tenant>:<conversationId>` |
| **Skills** | `skills/<tenant>/` directory |
| **Env Vars** | Injected into CLI subprocess from `config.tenants[].env` |
| **Concurrency** | Fair queuing, max 1 concurrent per tenant |
| **OpenClaw Skill** | `<!-- openclaw-tenant: NAME -->` routes to correct container |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Gateway port | `3456` |
| `HOST` | Bind address | `0.0.0.0` |
| `DOCKER_HOST_IP` | Docker host IP for containers | auto-detect |
| `CLAUDE_BIN` | Claude CLI path | `claude` |
| `CLI_TIMEOUT` | Request timeout (ms) | `900000` |
| `MAX_CONCURRENT` | Max concurrent CLI processes | `3` |

## API Endpoints

### `POST /v1/messages` (Anthropic)

```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "x-api-key: <tenant-key>" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4","max_tokens":1024,"stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

### `POST /v1/chat/completions` (OpenAI)

```bash
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer <tenant-key>" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4","messages":[{"role":"user","content":"Hello"}]}'
```

### `GET /health`

Returns gateway status, tenant list, and queue stats.

### `GET /v1/models`

Lists available models.

## OpenClaw Skill Prompt

The gateway injects `openclaw-skill.md` as a system prompt, teaching the Claude CLI how to execute OpenClaw operations. The skill auto-detects Docker vs local mode and routes commands to the correct container based on the `<!-- openclaw-tenant: NAME -->` context tag.

| Category | Commands |
|----------|----------|
| Cron/Scheduling | `cron add/rm/edit/enable/disable/run/list/status` |
| Messaging | `message send/read/broadcast/react/pin/poll` |
| Agents | `agent/agents list/add/bind/delete` |
| Sessions | `sessions list/cleanup` |
| Memory | `memory search/status/index` |
| Models | `models list/status/set` |
| Channels | `channels list/status` |
| Nodes | `nodes status/notify/camera/screen/invoke` |
| Directory | `directory self/peers/groups` |
| Skills | `skills list/info/check` |
| Config | `config get/set/unset/validate` |
| System | `health/status/doctor/heartbeat` |

## Architecture

```
                        ┌──────────────────────────────────────┐
                        │  openclaw-cc-gateway (:3456)          │
                        │                                       │
                        │  ┌─ Auth (per-tenant API key)         │
  OpenClaw instances    │  ├─ Queue (concurrency control)       │
  ┌──────────────┐      │  ├─ Session (per-tenant namespace)    │  ┌──────────┐
  │ tenant-a     │─────▶│  ├─ Env (per-tenant injection)        │──│ Claude   │
  │ tenant-b     │─────▶│  ├─ Skills (per-tenant directory)     │  │ CLI      │
  │ tenant-c     │─────▶│  └─ CLI subprocess (claude --print)   │  │ (Max)    │
  │ ...          │─────▶│     + --add-dir skills/<tenant>/*     │  └──────────┘
  └──────────────┘      │     + env vars from tenant config     │
                        │     + openclaw-skill.md injection      │
                        └──────────────────────────────────────┘
```

## Multi-turn Tool Handling

When the CLI uses tools internally (Bash, Read, etc.), it produces multiple message rounds. The gateway buffers intermediate tool-use rounds and only forwards the final `end_turn` response to the client, preventing pi-ai SDK "Unexpected event order" errors.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=derekchan10/openclaw-cc-gateway&type=Date)](https://star-history.com/#derekchan10/openclaw-cc-gateway&Date)

## License

[MIT](LICENSE)
