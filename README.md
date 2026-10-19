# dsh-codex-agy-plugin

DeepSeek Harness（DSH）的**插件**：装一次，就给你的**所有 Agent 模式**加上三个工具——
不需要新建「模式」，也不需要改任何预设。

| 工具 | 作用 |
| --- | --- |
| `subagent_codex` | 把一段自包含任务交给 Codex CLI（`codex app-server --stdio`），一次性执行，子进程可在会话工作目录里自己读写文件 |
| `subagent_agy` | 把任务交给 Antigravity CLI（`agy --print` 非交互模式），强制走本机代理 |
| `codex_imagegen` | 包装 Codex 自带的 imagegen 技能，用 GPT Image 生成/编辑位图；支持参考图、指定输出路径、一次生成网格母图并自动裁块 |

> 非官方项目：与 DeepSeek、OpenAI、Google 均无隶属关系，只是作者在自己的
> DSH Desktop 环境里验证可用的一套插件。

## 「插件」和「模式」的区别

DSH 里这是两种东西：

- **插件（组合包 bundle）**：装进 profile，可随手在侧栏「插件」页启停。它往 **Host 层**加行：
  注册服务、注册**全局工具**。全局工具对所有模式生效——官方 `Ralph 循环` 插件就是这么做的。
- **模式（Agent 预设 preset）**：新建会话时在模式选择器里选的那张卡片（标准 / 创造 / PTC /
  极简 / 自定义）。它是「一组插件的组合」。

本仓库是前者：`cordis.patch.yml` 只 `insert` Host 层行——两个子代理后端 + 一个全局工具组，
**不声明 preset**。启用后所有模式（包括极简）都能用这三个工具。

## 目录结构

```text
.
├── package.json        # 插件清单：exports + dsh.bundle.patch
├── cordis.patch.yml    # 插件层：Host 后端行 + 全局工具组
├── codex.mjs           # subagent_codex 后端（re-export 官方包 + 本地 reasoning effort 垫片）
├── agy.mjs             # subagent_agy 后端（Antigravity CLI print 模式适配器）
└── imagegen.mjs        # codex_imagegen 工具
```

三个 `.mjs` 都是自包含的 ESM 插件（只用相对导入和 `node:` 内置模块），不引入裸包依赖。

## 安装

### 方式一：插件页（推荐）

DSH 侧栏 → **插件** → **添加插件** → **安装第三方插件**，在输入框里填本仓库地址：

```text
https://github.com/jingfushen/dsh-codex-agy-plugin
```

或者填本地目录的绝对路径。安装完成点**立即启用**，插件页会出现 **Codex + AGY Tools**。
之后新会话直接可用；正在进行的会话在下一次请求时看到工具列表变化（切换插件会让该会话的
请求前缀缓存失效一次）。

### 方式二：手工接入 profile

编辑 `~/.dsh/profiles/<你的 profile>/package.json`：

```json
{
  "dependencies": {
    "dsh-codex-agy-plugin": "link:/absolute/path/to/this/repo"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-codex-agy-plugin"
      ]
    }
  }
}
```

然后在该 profile 目录 `pnpm install`，重启 DSH。

### 依赖：Codex 后端包

`subagent_codex` 依赖 `@deepseek-ai/dsh-subagent-codex`（它不随发行版分发，且版本要与 DSH
运行时对齐）。装到 DSH 配置目录下：

```bash
cd ~/.dsh/subagent-backends
npm install --omit=dev --ignore-scripts @deepseek-ai/dsh-subagent-codex@<与运行时同版本>
```

然后确认 `codex.mjs` 第 56 行的绝对路径指向它（见下面「换机器要改」第 1 条）。

## 前置条件

- **DeepSeek Harness Desktop 0.2.1-rc.2**（本插件只在这个运行时线验证过）
- **Codex CLI** 已安装并登录（ChatGPT 账号）；`codex_imagegen` 走 PATH 上的 `codex`
- **Antigravity CLI**：`agy` 在 PATH 上；`subagent_agy` 默认强制走 `http://127.0.0.1:12450` 代理
- **python3 + Pillow**：只有使用 `codex_imagegen` 的 `grid` 批量裁块时才需要
- Node.js 18+（插件本身不装依赖，由 DSH 运行时加载）

## 配置

所有配置都在 `cordis.patch.yml` 的行里，改完在插件页把插件关→开一次（或重启 DSH）即可：

- `subagent-codex-backend`
  - `model`：传给 Codex 每个 thread 的模型（默认 `gpt-5.6-sol`）
  - `reasoningEffort`：本地垫片，注入为 `-c model_reasoning_effort="<value>"`，只作用于子进程，
    不改 `~/.codex/config.toml`（默认 `max`）
  - `env`、`disposeGraceMs`
- `subagent-agy-backend`
  - `env`：默认把 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 指到 `http://127.0.0.1:12450`，
    `NO_PROXY` 清空；子进程环境是净化的，所以必须在这里显式给
  - `verifyProxy`：spawn 前先探测代理端口；确认代理常开可设 `false`
  - `command`、`outputArgs`、`disposeGraceMs`
- `codex-agy-tool-codex-imagegen`
  - `model`（默认 `gpt-6-astra`）、`reasoningEffort`（默认 `xhigh`）；设为 `null` 退回 Codex CLI 默认值
  - 另有 `command`、`codexHome`、`env`、`timeoutMs`（默认 15 分钟）、`pythonCommand`

## 换机器要改的地方

这是作者本机验证过的工作副本，**有几处机器相关配置**，复用到别的机器前请检查：

1. `codex.mjs` 第 56 行：用绝对路径 re-export 已安装的 codex 后端包
   （`~/.dsh/subagent-backends/node_modules/@deepseek-ai/dsh-subagent-codex/lib/index.js`），
   改成你的路径。
2. `agy.mjs` 的 `PROXY_URL` 常量与 patch 里的 `env`：默认 `127.0.0.1:12450`，
   改成你可用的代理地址；没有代理就把 `env` 留空并关掉 `verifyProxy`。
3. patch 里的模型 slug（`gpt-5.6-sol`、`gpt-6-astra`）：换成你账号实际可用的模型。
4. `~/.dsh/subagent-backends` 里的后端包版本要与 DSH 运行时同步。

## 已知限制

- **provider 名全局唯一**：`codex` / `agy` 已在 Host 层注册。不要在别的 bundle 或 profile
  补丁里重复注册同名 provider，否则第二次注册会抛错并导致整个挂载失败。
- **工具名不要重复**：如果某个模式（预设）也挂了 `subagent_codex` / `subagent_agy` /
  `codex_imagegen` 同名工具行，启用本插件后请把预设里那几行去掉。
- **改完插件代码要重新加载模块**：插件以软链形式安装时文件改动立刻落盘，但已加载的 ESM
  模块在进程内有缓存。用插件页关→开一次，或直接重启 DSH。
- `codex_imagegen` 认的是 PATH 上的 `codex`（登录 ChatGPT 的那个），`subagent_codex`
  用的是后端包自带的 `@openai/codex`，两者不是同一个二进制；升级时注意区分。
- `subagent_agy` 走 argv 传 prompt，超大任务（>256 KB）会被提前拒绝并给出明确报错。
- AGY 能否使用取决于账号/地区资格——适配器接线正确不代表服务端放行。

## 验证记录

工具级实测（2026-10-10/11，DSH Desktop 0.2.0-rc.2）：

- `node --check` 三个 `.mjs` 全部通过；工具注册形状用假 ctx 验证（`codex_imagegen`，
  `timeoutMs=900000`，schema 合法）
- `codex_imagegen` 真跑出图两次：默认模型 78s / `gpt-6-astra` + `xhigh` 44s，均肉眼确认
- `grid: {rows:2, cols:3}` 真跑：一张母图裁出 6 块（各 512×512），逐像素校验覆盖正确
- Codex 后端 app-server 握手 + `initialize` + `thread/start` 成功
- AGY 链路：代理端口可达，但服务端返回账号地区资格拒绝（账号侧问题，非适配器问题）

本仓库的插件层（Host 行 + 全局工具组）按官方 Ralph 插件的同款结构编写；加载组合可通过
`dsh --profile <name> --dump-config` 检查。

## 许可

本仓库暂未附开源许可证。如需复用、转载或商用，请先联系仓库作者。
