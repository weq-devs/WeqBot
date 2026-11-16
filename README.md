## WeqBot

> [!note]
>
> 纯协议独立bot框架，非常美味欢迎品鉴

入门与使用请参考[文档站](https://weq-devs.github.io/WeqBotDocs/)：
下载安装、登录与凭据、配置、运行原理、事件推送、OneBot 接口。

### 开发

```bash
git clone --recurse-submodules https://github.com/weq-devs/WeqBot.git
cd WeqBot
pnpm install
pnpm dev
```

`docs/` 是 [WeqBotDocs](https://github.com/weq-devs/WeqBotDocs) 的 submodule ——
克隆时带 `--recurse-submodules`，否则文档目录是空的（不影响代码运行）。

```bash
pnpm verify       # 架构护栏 + 类型检查 + 文档快照一致性 + 测试
pnpm docs:dev     # 本地预览文档（http://127.0.0.1:5175）
```

OneBot 动作文档由代码自动生成：改了 `packages/onebot/src/actions/` 后跑
`pnpm docs:actions` 更新 `schema/onebot-actions.json`。
