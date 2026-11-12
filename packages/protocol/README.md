# @weqbot/protocol

QQ 协议层：wire 字节 ↔ 业务对象。**本目录是 `WeQ/packages/protocol/src` 的逐字副本**，
只允许下表列出的偏离。

## 与上游的偏离（全部）

| 文件               | 改动                                                                                                                 | 为什么                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/transport.ts` | `NtHelperBinding` → `NativePort`；`pid: number` → `SsoTarget`；`Buffer` → `Uint8Array`；红包签名出口改为可选结构类型 | 宿主注入结构类型，不 import `@weq/native`；`SsoTarget` 同时容纳 pid 与 mode2 句柄 |
| `src/index.ts`     | 末尾新增 3 行：re-export `./client`                                                                                  | 本地便利门面的出口                                                                |
| `src/client.ts`    | **新增文件**                                                                                                         | `createProtocolClient`：绑定 `(native, target)` 的闭包，不含协议知识              |

除此之外**一个字都不要改**，包括注释里的错别字、`_` 前缀的死常量、格式。

## 为什么这么严

这份副本唯一的维护手段是 `diff -r`。任何本地风格改动都会混进 diff，让「上游到底改了什么」
变成人工考古。同理 `tsconfig.json` 不做额外严格化（见文件内注释）。

```bash
diff -r ../WeQ/packages/protocol/src packages/protocol/src
```

预期输出：`client.ts` 只在本地存在，`index.ts` / `transport.ts` 有差异，其余全静默。

## 同步上游

1. 在 WeQ 侧拿到目标 commit（版本锚见 `TODO.md` §10）。
2. `rsync -a --delete ../WeQ/packages/protocol/src/ packages/protocol/src/`
3. 重新套用上表三处改动（`git diff` 会比 `diff -r` 更早发现上游恰好也改了 `transport.ts`）。
4. `pnpm verify && pnpm lint`。
5. 字节一致性：把本包与被替换前的 WeQ 实现同时加载，对 `encode` / `decode` / `resolveSign`
   跑同一组向量，逐项 hex 相等。P1 当时的夹具是 `/tmp/parity.mjs`，跨仓路径所以不入库。

## 运行时约束

`proto/**` 是纯字节编解码，任意环境可用；`highway/**`、`msg/send.ts`、`msg/decode.ts` 等
用了 `node:crypto` / `node:fs` / `node:net` / `node:zlib` —— **只能在 Node 进程里跑**
（sidecar 或 desktop 主进程），不能进渲染进程。以后若要给 WebView 用，做法是把纯字节
部分单独出一层，而不是把这些文件改写掉。

## 不依赖 `@weq/codec`

那个包是**解数据库**用的（`SqlRow` + schema DSL → 元素 / 域模型），与网线协议是两套模型。
元素词表的唯一来源是 `src/msg/schemas.ts` 的 `ELEM`。
