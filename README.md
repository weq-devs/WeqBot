## WeqBot

> [!note]
>
> 纯协议独立bot框架，非常美味欢迎品鉴

入门与使用请参考[文档站](https://weq-devs.github.io/WeqBotDocs/)：
下载安装、登录与凭据、配置、运行原理、事件推送、OneBot 接口。

### OneBot 发送字体

`send_msg` 的可选参数 `font_id` 仅用于群聊，接受 1 到 65535 的整数。私聊传入该参数会返回参数错误。

```json
{ "action": "send_msg", "params": { "group_id": 12345, "message": "你好", "font_id": 22045 } }
```

发送时显式写入 `font1=0`（`37.19.56`），将字体 ID 的低 16 位交换字节后加上
`0x10000`，写入 `font2`（`37.19.15`）。真机群聊已验证 `22045` 可以通过
`font2=0x11D56` 发送。同一字体 ID 的 `font2=0x184EA` 和 `0x484EA` 在测试中显示为同一款字体。

### 开发

改动通过 PR 合并到 `main`，合并前需要通过子模块检出检查。修改文档时，先推送 [WeqBotDocs](https://github.com/weq-devs/WeqBotDocs) 的提交，再更新主仓里的 `docs` 指针。

```bash
git clone --recurse-submodules https://github.com/weq-devs/WeqBot.git
cd WeqBot
pnpm install
pnpm dev
```
```

```
