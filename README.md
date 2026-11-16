# WeqBot

独立的 QQ bot 框架：自己完成登录、上线注册与心跳（**mode2**），不借用 QQ 客户端的在线会话；
也可以作为**纯 TypeScript** 嵌进 WeQ desktop，由宿主注入已有的原生组件。

## 三处运行形态

| 形态             | 原生组件                                                          | 入口                                         |
| ---------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| 独立进程         | `nt_helper` 完整产物（`native/<platform>/<arch>/nt_helper.node`） | `@weqbot/node`                               |
| 嵌入 WeQ desktop | 复用 WeQ 的 full 产物（同一文件，第二进程加载），**不带 `.node`** | `@weqbot/node --sidecar` + `@weqbot/control` |
| 测试             | 桩实现                                                            | 任意包                                       |

WeQ 侧是 **sidecar 子进程**，不是同进程对象注入：一个进程只服务一个账号，
多账号 = 多进程，生命周期随 desktop（D6）。凭据通过控制通道交付，不跨进程共享内存。

## 分层

```
common  ←  wire  ←  protocol  ←  session  ←  onebot
                        ↑            ↑          ↑
                        └────────── bot ────────┘
                                     ↑
                                   node  ──→  control  ──→  common / wire
```

- `node` 是唯一允许加载 `.node` 的包；`control` 是 desktop 与 sidecar 之间唯一的共享契约
  （NDJSON over stdio），零业务依赖。

- **`@weqbot/common`** — 日志 / 错误码 / 事件总线 / 退避 / 字节工具，零业务依赖。
- **`@weqbot/wire`** — `NativePort` 契约、`SessionId` / `SessionMode`、能力探测、宿主绑定适配。
- **`@weqbot/protocol`** — protobuf 运行时、OIDB/trpc spec、消息编解码、推送解码（搬运自 `@weq/protocol`）。
- **`@weqbot/session`** — a1 凭据、`quickLogin`、`openSession(mode 1|2)`、状态机、`BotEvent` 契约。
- **`@weqbot/onebot`** — OneBot v11 事件/动作/网络适配。
- **`@weqbot/bot`** — `createBot()` 门面，宿主与测试的唯一入口。
- **`@weqbot/control`** — desktop ↔ sidecar 控制通道契约与 NDJSON 编解码。
- **`@weqbot/node`** — 独立宿主、sidecar 入口与 CLI。

## 文档

完整文档在 [`docs/`](./docs/index.md)（VitePress）：

```bash
pnpm docs:dev     # http://127.0.0.1:5175
pnpm docs:build   # 静态构建到 docs/.vitepress/dist
```

内容分四块：使用手册（下载安装 / 登录 / 配置）、运行原理（架构 / 会话 / 凭据 / 嵌入）、
事件推送（语义层 `BotEvent` 全量）、OneBot 接口（205 条动作，**由代码自动生成**）。

## 快速开始（从 clone 开始）

```bash
git clone https://github.com/weq-devs/WeqBot.git && cd WeqBot
pnpm dev
```

`pnpm dev` 会把开发环境一次备齐再启动：依赖缺失时 `pnpm install`，原生组件能力不齐时
换一份、前端 `dist/` 缺失或比源码旧时 `build:webui`，最后起控制台并打印带令牌的链接。
参数原样透传给 CLI：

```bash
pnpm dev -- --account <uin> --config packages/node/config.example.json
pnpm dev -- --rebuild     # 强制重建前端
pnpm dev -- --release     # 跳过本地构建，强制用 release 产物
pnpm dev -- --help        # 只打印这个脚本的说明
```

::: warning 开发期原生组件要用本地构建

发布仓 `native/pinned.json` 锚的那份是**旧 napi 绑定构建**，没有 `openSession` /
`attachPushSink`，只能登录换票、跑不了 mode2 上线。`pnpm dev` 会优先找与本仓同级的
`../nt_helper`（或 `NT_HELPER_DIR`）里的 `index.<platform>-<arch>-*.node`；找不到才回落到
release 产物，并在能力不足时**明确报错**而不是起一个半残的控制台。

上游修好后这一分支会自然不再被走到，脚本不需要改。

:::

## 命令

```bash
pnpm install
pnpm verify          # 架构护栏 + 全量类型检查 + 文档快照一致性 + 契约测试
pnpm typecheck
pnpm test
pnpm lint
pnpm check:pure-ts   # 只跑架构护栏
pnpm dev:cli --help  # CLI（源码直接跑，靠 tsx；P6 再出打包产物）
```

OneBot 文档快照：

```bash
pnpm docs:actions          # 从 action 代码重新生成 schema/onebot-actions.json
pnpm docs:actions:check    # 只校验是否最新（`pnpm verify` 已包含）
```

改了 action 的 `summary` / `description` / `inputSchema` 后必须重跑 `docs:actions`，
否则 `actions-snapshot.test.ts` 会红。

控制台（WebUI）：

```bash
pnpm dev:cli                                            # 只起控制台，浏览器里选账号登录
pnpm dev:cli --account <uin> --config <cfg>            # 先上线，再提供控制台
pnpm dev:cli --account <uin> --no-webui                # 纯 CLI，不开控制台
pnpm dev:webui                                         # 前端开发服务器（/api 代理到 6299）
VITE_WEBUI_MOCK=1 pnpm dev:webui                       # 脱离后端看界面（mock 数据）
pnpm build:webui                                       # 构建 dist/，由控制台服务托管
```

控制台只监听 `127.0.0.1:6299`（`--webui-port` / `--webui-host` 可改），启动时终端打印
带令牌的一键链接 `http://127.0.0.1:6299/#token=…`。令牌每次启动重新生成，可用
`WEQBOT_WEBUI_TOKEN` 固定；会话走 HttpOnly cookie，连续 5 次输错锁 30 秒。
页面：访问令牌 → 账号登录（本机 `login.db` 账号 / 扫码 / 环境检查）→ 总览 / 网络 /
日志 / 调试。

真机相关：

```bash
pnpm dev:cli --account <uin> --config packages/node/config.example.json   # 起 bot（含 OneBot）
pnpm smoke:onebot --url ws://127.0.0.1:6700 --self <uin>         # 只读冒烟
pnpm smoke:onebot --url ws://127.0.0.1:6700 --self <uin> --send  # 含真实发消息
```

配置样例见 `packages/node/config.example.json`（字段说明见[配置文件](./docs/guide/config.md)）；
完整真机验证流程见 `REAL-DEVICE-CHECKLIST.md`（本地文件，不入库）。

## 约束（由 `scripts/check-pure-ts.mjs` 强制）

1. 除 `packages/node` 外，任何代码不得出现 `.node` / `process.dlopen` / `createRequire`。
2. 不得依赖 `@weq/*` 私有包 —— bot 必须能独立构建、独立发版。
3. 依赖只能从右向左（`common` 最底层）。
4. 不得 import `@weqbot/node` —— 否则宿主打包会带上第二份原生组件。
5. `@weqbot/control` 只能依赖 `common` / `wire` —— 它会同时被打进 WeQ 与 sidecar。

## 许可证

本项目基于 [**CC BY-NC-SA 4.0**](./LICENSE)（知识共享 署名-非商业性使用-相同方式共享 4.0 国际）
发布，与主仓库 `weq-devs/WeQ` 同款：

- **署名（BY）** —— 注明来源为 `weq-devs/WeqBot`，并注明是否做了修改；
- **非商业性使用（NC）** —— **禁止任何形式的商业使用**；
- **相同方式共享（SA）** —— 衍生作品必须以**相同的 CC BY-NC-SA 4.0** 发布。

⚠️ 注意：本项目并未整体转为 CC BY-NC-SA。`packages/protocol` 是 `WeQ/packages/protocol`
的逐字副本、部分 wire schema 搬运自 **SnowLuma**（其许可是非开源的
Source-Available Non-Commercial，且**公开发布衍生版需事先书面许可**），
另有若干第三方依赖遵循各自许可证。详见
[`packages/protocol/README.md`](./packages/protocol/README.md) 的「许可与来源」一节。
若要公开发布衍生版本，请先确认这几处的授权口径。

## 版本

版本号未定，`0.0.0` 只是占位。**不要**在功能提交里顺手改版本号。
