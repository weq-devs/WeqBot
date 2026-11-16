# @weqbot/protocol

QQ 协议层：wire 字节 ↔ 业务对象。**本目录是 `WeQ/packages/protocol/src` 的逐字副本**，
只允许下表列出的偏离。

## 与上游的偏离（全部）

| 文件               | 改动                                                                                                                 | 为什么                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/transport.ts` | `NtHelperBinding` → `NativePort`；`pid: number` → `SessionId`；`Buffer` → `Uint8Array`；红包签名出口改为可选结构类型 | 宿主注入结构类型，不 import `@weq/native`；会话身份由 native 分配的 `SessionId` 持有，pid 只留在进程层 |
| `src/index.ts`     | 末尾新增 3 行：re-export `./client`                                                                                  | 本地便利门面的出口                                                                                     |
| `src/client.ts`    | **新增文件**                                                                                                         | `createProtocolClient`：绑定 `(native, target)` 的闭包，不含协议知识                                   |

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

## 许可与来源

本目录的代码来源有三处，授权口径并不相同。**改这一节之前先跟维护者确认**。

| 来源                        | 范围                                                                                                                  | 许可                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `WeQ/packages/protocol/src` | 主体（本目录的逐字副本）                                                                                              | 与主仓库一致：CC BY-NC-SA 4.0                                    |
| SnowLuma                    | 部分 OIDB / web 的 wire schema、字段常量、解码逻辑（`grep -rl SnowLuma src/` 共 82 个文件，其中 17 个文件头写了出处） | **非开源**：SnowLuma Source-Available Non-Commercial License 1.0 |
| 第三方依赖                  | `protobufjs` / `ws` 等                                                                                                | 各自原许可证                                                     |

**SnowLuma 的许可是这里最紧的一环**（`../SnowLuma/SnowLuma/LICENSE`）：

- 允许查看、学习、非商业使用与私有修改；
- 再分发时必须附完整许可文本、保留全部署名；
- **公开发布修改版或衍生版须事先取得著作权人书面许可**；未经授权也不得「基于它开发、
  发布或分发另一个项目」。

维护者（2026-11-15）已就「抄 wire schema / 字段常量 / 解码逻辑」取得授权，因此内部与
非商业自用没有问题。但**对外发版属于公开发布**：发布前需要确认这条口径仍然成立，
或把相关文件改写成独立实现。新增抄自 SnowLuma 的文件，在文件头写明来源路径
（现有做法，见 `src/oidb/group-admin/set-group-admin.ts`）。
