<p align="center">
  <img src="apps/web/public/mark.svg" width="64" alt="Muster">
</p>

<h1 align="center">Muster · 点兵</h1>

<p align="center">
  <b>面向企业的开源 Agent 工作台，自带管控平面。</b><br>
  让每位员工都有能处理日常办公的 Agent，<br>
  让公司对每一个 Agent 有花名册、有网关、有记录。
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

![工作台里的一条回复：Agent 直接给出表格和图表，而不是一大段文字](docs/screens/zh/workspace-reply.png)

## 它是什么

企业要让 Agent 真正干活，需要三样东西：员工用的入口、公司管的后台、能被规则约束的运行时。Muster 把三样做在一个仓库里，用同一个许可证。

| | 你得到什么 | 同类产品 |
|---|---|---|
| **员工用的工作台** | Web、macOS 桌面端，以及可从源码构建的 iOS 端。和 Agent 对话，回复直接是界面（表格、表单、图表），存文档和文件，自己搭 Agent。 | 腾讯 WorkBuddy |
| **公司管的管控平面** | 每个 Agent 有自己的身份和风险等级。审批、每次运行的追踪、用量和成本、只增不改的活动日志，单点登录（Google、Microsoft、OIDC、SAML）和 SCIM；飞书、企业微信、钉钉登录与通讯录同步（新）。 | Microsoft Agent 365 |
| **受管控的运行时** | 基于 OpenClaw 的 Agent 循环。每一次工具调用都过同一道网关：放行、先问人、或拒绝。代码在沙箱里跑，只能访问管理员允许的主机。 | 基于 OpenClaw |

不同之处：Agent 和对它的管控是同一个系统。Agent 做的任何事都绕不过网关，管理后台里看到的每个 Agent 也都跑在你看得见的地方。

部署在你自己的机器上。模型你来选：Anthropic，或任何兼容 OpenAI chat completions 的接口，包括你自己部署的模型。

## 看一眼

<table>
<tr>
<td width="50%" valign="top"><a href="docs/screens/zh/workspace-start.png"><img src="docs/screens/zh/workspace-start.png" alt="开始页"></a><br><b>开始页</b><br>说出需求、拖入文件、选一个 Agent。“先问我”决定它不问你能做到哪一步。</td>
<td width="50%" valign="top"><a href="docs/screens/zh/workspace-agents.png"><img src="docs/screens/zh/workspace-agents.png" alt="Agent 列表"></a><br><b>Agent 列表</b><br>公司提供的 Agent、各自能触达什么，以及自己搭一个的入口。</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="docs/screens/zh/admin-overview.png"><img src="docs/screens/zh/admin-overview.png" alt="总览"></a><br><b>总览</b><br>运行次数、成功率、成本、使用人数，以及需要处理的事项。</td>
<td width="50%" valign="top"><a href="docs/screens/zh/admin-agents.png"><img src="docs/screens/zh/admin-agents.png" alt="Agent 花名册"></a><br><b>Agent 花名册</b><br>每个 Agent 的负责人、风险等级、状态和最近运行。可批准、停用、恢复。</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="docs/screens/zh/admin-policies.png"><img src="docs/screens/zh/admin-policies.png" alt="策略"></a><br><b>策略</b><br>每个工具三选一：放行、先问人、关闭（Agent 调用时即被拒绝）。可对全员或按部门设置。</td>
<td width="50%" valign="top"><a href="docs/screens/zh/admin-traces.png"><img src="docs/screens/zh/admin-traces.png" alt="运行追踪"></a><br><b>运行追踪</b><br>每一次运行：谁、哪个 Agent、耗时、Token、成本、结果。</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="docs/screens/zh/admin-trace.png"><img src="docs/screens/zh/admin-trace.png" alt="单次运行的每一步"></a><br><b>单次运行的每一步</b><br>一次运行里的每个决策、工具调用和策略检查，带输入输出。</td>
<td width="50%" valign="top"><a href="docs/screens/zh/admin-usage.png"><img src="docs/screens/zh/admin-usage.png" alt="用量与预算"></a><br><b>用量与预算</b><br>按部门和个人统计成本，可给公司和每个人设上限。</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="docs/screens/zh/admin-audit.png"><img src="docs/screens/zh/admin-audit.png" alt="活动日志"></a><br><b>活动日志</b><br>每次登录和管理操作都有记录，每条带着上一条的指纹，可校验是否被改动。</td>
</tr>
</table>

截图来自 `pnpm dev` 自带的示例组织。

## 先跑起来

需要 Node.js 22.12 以上和 pnpm 11。克隆本仓库，然后：

```bash
pnpm install
```

```bash
pnpm dev
```

打开 http://localhost:5173，选一个开发账号；`owner@muster.test` 可以进管理后台。Agent 需要模型：把 `.env.example` 复制为 `.env`，填上 `MUSTER_MODEL_*` 几行。

## 给公司部署

一台装了 Docker 的机器：服务端（同时提供 Web 应用）、PostgreSQL 和沙箱。默认从源码构建；发布版镜像在 GitHub 的镜像仓库。

```bash
cp deploy/.env.example deploy/.env
```

填好 `deploy/.env`：对外地址、第一位所有者的邮箱、数据库密码，以及至少一种登录方式。然后：

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
```

在 7410 端口前放一个终结 TLS 的反向代理。运行代码需要 Docker 里装有 gVisor。升级、备份、单点登录和排错都在 [`docs/runbook.md`](docs/runbook.md)。

桌面端在 [`apps/desktop`](apps/desktop/README.md)，iOS 端在 [`apps/mobile`](apps/mobile/README.md)，首次打开时都会问你的服务器地址。

## 现在到哪了

Muster 还没到 1.0。它端到端可用；配置、数据库结构和接口在小版本之间仍可能变化，变了会写在 [`CHANGELOG.md`](CHANGELOG.md) 里。

还没做的：花名册管的是在 Muster 里搭建和运行的 Agent，不包括跑在别处的 Agent。每个功能自己的边界写在 [`docs/features`](docs/features/README.md) 的 "what is not built" 一节。

## 常被问到的

- **数据会出内网吗？** Agent 读到的内容会发给你选的模型；模型自己部署，就不出内网。联网搜索默认关闭。
- **支持哪些登录方式？** 飞书、Lark、企业微信、钉钉登录，部门和人员随通讯录自动同步（新功能：飞书已在真实企业上跑通，Lark、企业微信、钉钉尚未实测）。Google、Microsoft、任何 OpenID Connect 提供方（Keycloak、Authing、Okta、Authentik）、SAML 2.0，另有 SCIM 2.0 同步人员。还没做：LDAP。
- **有中文界面吗？** 有，界面支持简体中文和英文。
- **能撑多大规模？** 目前是单机部署，一个数据库对应一个服务端容器，还没有高可用方案。备份、升级和回退见运行手册。

## 基于 OpenClaw

Muster 的 Agent 循环来自 [OpenClaw](https://github.com/openclaw/openclaw)（MIT 许可），按 `v2026.9.8` 版本逐块取入 [`vendor/openclaw`](vendor/openclaw)。本仓库不是 OpenClaw 仓库的 fork：这里取用了其中三个包，在此致谢；围绕它们的一切（网关、沙箱、管控平面、各端应用）都是 Muster 自己写的。取了什么、没取什么、改了什么，逐条记录在 [`vendor/openclaw/UPSTREAM.md`](vendor/openclaw/UPSTREAM.md)。

Muster 是独立项目，与 OpenClaw Foundation、腾讯、微软均无关联。WorkBuddy 和 Agent 365 是各自所有者的商标，这里仅用于对照说明。

## 目录

```
apps/server        服务端：登录、成员、Agent、运行、审批、追踪
apps/web           Web 应用：工作台，以及 #/admin 下的管理后台
apps/desktop       桌面端（Electron）
apps/mobile        iOS 端（Expo，不在 pnpm workspace 内）
apps/sandbox       运行 Agent 的代码，每次运行一个独立容器
packages/protocol  身份与审计事件的定义
packages/ui-schema Agent 回复可以使用的组件（OpenUI）
vendor/openclaw    运行时所基于的 OpenClaw 部分
deploy/            compose 文件和环境变量示例
docs/              锁定的决策、功能说明、运行手册
```

## 版本与发布

整个产品一个版本号，遵循[语义化版本](https://semver.org/lang/zh-CN/)，标签为 `vX.Y.Z`。每个版本有 [`CHANGELOG.md`](CHANGELOG.md) 里的说明、一个容器镜像和一个 GitHub Release。发布步骤见 [`docs/releasing.md`](docs/releasing.md)。

## 参与贡献

Bug 和想法：提 issue。代码：先读 [`CONTRIBUTING.md`](CONTRIBUTING.md)，CI 跑的就是 `pnpm check`。安全问题：按 [`SECURITY.md`](SECURITY.md) 私下报告，不要开公开 issue。

## 许可证

[Apache-2.0](LICENSE)。第三方声明见 [`NOTICE`](NOTICE)。
