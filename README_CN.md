# OpenClaw CC Gateway

[English](README.md) | 中文

为 [OpenClaw](https://github.com/openclaw/openclaw) 设计的多租户 Claude Code CLI 网关。通过 Claude Code CLI 子进程路由 LLM 请求，绕过 Anthropic 2026 年 4 月的第三方 OAuth 限制，实现按租户隔离的 skill、会话和环境变量。

## 特性

- **Anthropic Messages API** (`/v1/messages`) — OpenClaw 使用的原生格式
- **OpenAI Chat API** (`/v1/chat/completions`) — 兼容端点
- **多租户隔离** — 按租户隔离 API Key、会话、Skill、环境变量和并发
- **自动发现** — 自动识别 Docker 和本地 OpenClaw 实例
- **一键配置** — 生成配置、同步 Skill、提取环境变量
- **按租户 Skill 隔离** — 每个租户只加载自己的 OpenClaw Skill（`skills/<租户>/`）
- **按租户环境变量** — 自动从各实例的 `openclaw.json` 提取
- **OpenClaw Skill 提示词** — 教 Claude CLI 使用 `openclaw` 命令（定时任务、消息、Agent 等）
- **多轮工具缓冲** — CLI 内部执行工具，仅返回最终响应
- **流式 SSE** — 完整的 Anthropic 流式事件透传

## 工作原理

```
OpenClaw 容器 (tenant=alice)
  → POST /v1/messages (x-api-key: alice-key)
    → openclaw-cc-gateway
      → 认证 → tenant=alice
      → 注入 config.tenants[alice].env 中的环境变量
      → 加载 skills/alice/ 中的 Skill
      → 启动 claude CLI 子进程
        → Claude Max 订阅（绕过 OAuth 限制）
      → 缓冲工具调用轮次，仅返回最终响应
    ← Anthropic SSE 流
  ← Agent 处理响应
```

## 快速开始

### 前置条件

- Node.js 22+
- Claude Code CLI：`npm install -g @anthropic-ai/claude-code && claude auth login`
- Docker（如果使用容器化的 OpenClaw）

### 安装与配置

```bash
git clone https://github.com/derekchan10/openclaw-cc-gateway.git
cd openclaw-cc-gateway
npm install
npm run build

# 自动发现 OpenClaw 实例、生成配置、同步 Skill
node dist/index.js --setup
```

自动完成以下操作：
1. 检测 Docker 宿主机 IP
2. 发现所有运行中的 OpenClaw 容器
3. 从每个实例的 `openclaw.json` 提取环境变量
4. 生成 `config.yaml`（含 API Key 和环境变量）
5. 更新每个实例的 `openclaw.json` 指向网关
6. 按租户同步 Skill（`skills/<租户>/`）

使用 `--no-skills` 跳过 Skill 同步，或 `--skills` 仅同步 Skill。

### 启动

```bash
npm start

# 或使用 PM2
pm2 start dist/index.js --name openclaw-cc-gateway
pm2 save
```

## 租户管理

```bash
# 列出所有租户
npm run manage list

# 添加新租户（自动生成 API Key）
npm run manage add <名称>
npm run manage add <名称> --apply        # 添加并立即应用到 OpenClaw 实例

# 删除租户
npm run manage remove <名称>

# 推送配置到 OpenClaw 实例
npm run manage apply                     # 所有租户
npm run manage apply <名称>              # 单个租户

# 生成随机 API Key
npm run manage gen-key
```

`apply` 命令会更新：
- 实例的 `openclaw.json`（模型提供商 baseUrl + apiKey）
- 实例的 `.env` 文件（ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY）

## Skill 管理

Skill 按**租户隔离**，支持**双向同步** — 每个 OpenClaw 实例有独立的 Skill 目录，可以从容器拉取也可以推送到容器。

```bash
# 列出 Skill
npm run manage skills list               # 所有租户
npm run manage skills list <名称>        # 单个租户

# 拉取：OpenClaw → 本地
npm run manage skills pull               # 所有租户
npm run manage skills pull <名称>        # 单个租户

# 推送：本地 → OpenClaw
npm run manage skills push               # 所有租户
npm run manage skills push <名称>        # 单个租户

# 差异对比
npm run manage skills diff               # 所有租户
npm run manage skills diff <名称>        # 单个租户

# 双向同步：拉取远程新增 + 推送本地新增
npm run manage skills bisync             # 所有租户
npm run manage skills bisync <名称>      # 单个租户

# 清理
npm run manage skills clean
```

### 同步方向

| 命令 | 方向 | 说明 |
|------|------|------|
| `pull` | OpenClaw → 本地 | 从容器下载 Skill 到 `skills/<租户>/` |
| `push` | 本地 → OpenClaw | 从 `skills/<租户>/` 上传到容器的 `workspace/skills/` |
| `diff` | — | 显示本地独有、远程独有和共有的 Skill |
| `bisync` | 双向 | 拉取远程新增 + 推送本地新增（不覆盖已有） |

### Skill 隔离结构

```
skills/
├── alice/                 ← 仅在 tenant=alice 时加载
│   ├── github/SKILL.md
│   ├── custom-tool/
│   └── ...
├── bob/                   ← 仅在 tenant=bob 时加载
│   ├── github/SKILL.md
│   ├── another-skill/
│   └── ...
└── ...
```

每个租户的 CLI 子进程通过 `--add-dir skills/<租户>/<skill>` 加载自己的 Skill，其他租户的 Skill 不会被加载。

## 配置

### config.yaml

由 `--setup` 自动生成，也可从 `config.example.yaml` 手动创建：

```yaml
server:
  port: 3456
  host: "0.0.0.0"
  docker_host_ip: "auto"           # 自动检测，或设置 DOCKER_HOST_IP 环境变量

cli:
  bin: "claude"
  timeout: 900000                   # 每个请求 15 分钟超时
  max_concurrent: 3                 # 最大并行 CLI 子进程数

session:
  ttl: 3600
  cleanup_interval: 900

skills:
  sync: "auto"                     # auto | manual | disabled
  dir: "./skills"                  # 按租户的 Skill 存储目录

tenants:
  - name: alice
    api_key: "<hex-string>"
    env:                           # 从 openclaw.json 自动提取
      MY_API_KEY: "xxx"
      MY_SECRET: "xxx"
  - name: bob
    api_key: "<hex-string>"
```

### 按租户隔离

| 资源 | 隔离方式 |
|------|---------|
| **API Key** | 每个租户独立 |
| **会话** | `<租户>:<conversationId>` 命名空间 |
| **Skill** | `skills/<租户>/` 独立目录 |
| **环境变量** | 从 `config.tenants[].env` 注入 CLI 子进程 |
| **并发** | 公平排队，每租户最多 1 个并发 |
| **OpenClaw 命令** | `<!-- openclaw-tenant: NAME -->` 路由到正确容器 |

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 网关端口 | `3456` |
| `HOST` | 绑定地址 | `0.0.0.0` |
| `DOCKER_HOST_IP` | 容器可访问的宿主机 IP | 自动检测 |
| `CLAUDE_BIN` | Claude CLI 路径 | `claude` |
| `CLI_TIMEOUT` | 请求超时（毫秒） | `900000` |
| `MAX_CONCURRENT` | 最大并行 CLI 进程数 | `3` |

## API 端点

### `POST /v1/messages`（Anthropic 格式）

```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "x-api-key: <tenant-key>" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4","max_tokens":1024,"stream":true,"messages":[{"role":"user","content":"你好"}]}'
```

### `POST /v1/chat/completions`（OpenAI 格式）

```bash
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer <tenant-key>" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4","messages":[{"role":"user","content":"你好"}]}'
```

### `GET /health`

返回网关状态、租户列表和队列统计。

### `GET /v1/models`

列出可用模型。

## OpenClaw Skill 提示词

网关注入 `openclaw-skill.md` 作为系统提示词，教 Claude CLI 如何执行 OpenClaw 操作。Skill 自动检测 Docker 或本地模式，根据 `<!-- openclaw-tenant: NAME -->` 标签将命令路由到正确的容器。

| 类别 | 命令 |
|------|------|
| 定时任务 | `cron add/rm/edit/enable/disable/run/list/status` |
| 消息收发 | `message send/read/broadcast/react/pin/poll` |
| Agent 管理 | `agent/agents list/add/bind/delete` |
| 会话管理 | `sessions list/cleanup` |
| 记忆搜索 | `memory search/status/index` |
| 模型管理 | `models list/status/set` |
| 渠道管理 | `channels list/status` |
| 节点设备 | `nodes status/notify/camera/screen/invoke` |
| 通讯录 | `directory self/peers/groups` |
| Skill | `skills list/info/check` |
| 配置 | `config get/set/unset/validate` |
| 系统 | `health/status/doctor/heartbeat` |

## 架构

```
                        ┌──────────────────────────────────────┐
                        │  openclaw-cc-gateway (:3456)          │
                        │                                       │
                        │  ┌─ 认证（按租户 API Key）             │
  OpenClaw 实例         │  ├─ 队列（并发控制）                   │
  ┌──────────────┐      │  ├─ 会话（按租户命名空间）             │  ┌──────────┐
  │ tenant-a     │─────▶│  ├─ 环境变量（按租户注入）             │──│ Claude   │
  │ tenant-b     │─────▶│  ├─ Skill（按租户目录）                │  │ CLI      │
  │ tenant-c     │─────▶│  └─ CLI 子进程 (claude --print)       │  │ (Max)    │
  │ ...          │─────▶│     + --add-dir skills/<tenant>/*     │  └──────────┘
  └──────────────┘      │     + 租户环境变量                     │
                        │     + openclaw-skill.md 注入           │
                        └──────────────────────────────────────┘
```

## 多轮工具处理

当 CLI 内部使用工具（Bash、Read 等）时，会产生多轮消息。网关缓冲中间的工具调用轮次，仅将最终的 `end_turn` 响应转发给客户端，防止 pi-ai SDK 的"Unexpected event order"错误。

## 许可证

[MIT](LICENSE)
