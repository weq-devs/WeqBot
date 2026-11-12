# WeqBot

独立的 QQ bot 框架：自己完成登录、上线注册与心跳（**mode2**），不借用 QQ 客户端的在线会话；
也可以作为**纯 TypeScript** 嵌进 WeQ desktop，由宿主注入已有的原生组件。

## 三处运行形态

| 形态             | 原生组件                                                          | 入口                                         |
| ---------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| 独立进程         | 自带 **slim** 产物（`native/<platform>-<arch>/weqbot.node`）      | `@weqbot/node`                               |
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

## 命令

```bash
pnpm install
pnpm verify          # 架构护栏 + 全量类型检查 + 契约测试
pnpm typecheck
pnpm test
pnpm lint
pnpm check:pure-ts   # 只跑架构护栏
pnpm dev:cli --help  # CLI（源码直接跑，靠 tsx；P6 再出打包产物）
```

## 约束（由 `scripts/check-pure-ts.mjs` 强制）

1. 除 `packages/node` 外，任何代码不得出现 `.node` / `process.dlopen` / `createRequire`。
2. 不得依赖 `@weq/*` 私有包 —— bot 必须能独立构建、独立发版。
3. 依赖只能从右向左（`common` 最底层）。
4. 不得 import `@weqbot/node` —— 否则宿主打包会带上第二份原生组件。
5. `@weqbot/control` 只能依赖 `common` / `wire` —— 它会同时被打进 WeQ 与 sidecar。

## 版本

版本号未定，`0.0.0` 只是占位。**不要**在功能提交里顺手改版本号。
