#!/usr/bin/env -S node --import tsx
/**
 * OneBot 真机冒烟：一次性跑完 P4 的验收项。
 *
 * 为什么不写在 test/ 里：这些用例要**真账号、真网络、真好友**，而且其中几项
 * 会真的发消息。单测里做不了，也不该在 CI 里跑。
 *
 * 用法（bot 已经在另一个终端跑着）：
 *
 *   node --import tsx scripts/smoke-onebot.mjs --url ws://127.0.0.1:6700 --self 10002
 *
 * 全部只读用例默认执行；会**发消息**的用例要显式加 `--send`：
 *
 *   node --import tsx scripts/smoke-onebot.mjs --url ws://127.0.0.1:6700 \
 *     --self 10002 --send --peer 10001 --group 55555
 *
 * 输出是一张 PASS/FAIL/SKIP 表，末尾给出「哪些 V 项还没结论」。
 */

import { parseArgs } from 'node:util';
// Node ≥ 22 自带 WebSocket（undici），不引 `ws` —— 后者只装在 packages/onebot 里，
// 仓库根解析不到，这个脚本要能直接跑。
const { WebSocket } = globalThis;

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://127.0.0.1:6700' },
    token: { type: 'string' },
    self: { type: 'string' },
    peer: { type: 'string' },
    group: { type: 'string' },
    send: { type: 'boolean', default: false },
    /**
     * 只读：连幂等写操作也跳过（`set_group_whole_ban` 会往群里发一条变更请求）。
     * 「不发消息」的场景请加这个开关 —— 它保证脚本里没有任何非 GET 语义的调用。
     */
    readonly: { type: 'boolean', default: false },
    'image-path': { type: 'string' },
    'timeout-ms': { type: 'string', default: '10000' },
  },
});

const TIMEOUT = Number(values['timeout-ms']);
const results = [];

/** 发一条 action 并等**同 echo** 的响应。用标准 addEventListener / removeEventListener。 */
function call(socket, action, params = {}, echo = action) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${action} 超时`)), TIMEOUT);
    timer.unref?.();
    const onMessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (payload.echo !== echo) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      resolve(payload);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ action, params, echo }));
  });
}

async function check(name, fn, vTag) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', detail: detail ?? '', ms: Date.now() - started, vTag });
  } catch (error) {
    if (error === SKIP) {
      results.push({ name, status: 'SKIP', detail: '缺少参数', ms: 0, vTag });
      return;
    }
    results.push({
      name,
      status: 'FAIL',
      detail: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
      vTag,
    });
  }
}

const SKIP = Symbol('skip');

/** OneBot 成功响应取值，失败时把 retcode/wording 抛出来。 */
function data(response) {
  if (response.status !== 'ok') {
    throw new Error(`retcode=${response.retcode} ${response.wording ?? ''}`.trim());
  }
  return response.data;
}

function connect(url, token) {
  const target = token
    ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
    : url;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target);
    const timer = setTimeout(() => reject(new Error('连接超时')), TIMEOUT);
    timer.unref?.();
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error(`连接失败：${target}（bot 没起 or 端口 / token 不对）`));
      },
      { once: true },
    );
  });
}

let socket;
try {
  socket = await connect(values.url, values.token);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('先起 bot：weqbot --account <uin> --config docs/config.example.json');
  process.exit(2);
}
const events = [];
socket.addEventListener('message', (event) => {
  try {
    const payload = JSON.parse(String(event.data));
    if (payload.post_type) events.push(payload);
  } catch {
    /* action 响应，忽略 */
  }
});

// ───────────────────────── 连接与元信息 ─────────────────────────

await check(
  'get_version_info（纯本地）',
  async () => {
    const info = data(await call(socket, 'get_version_info'));
    if (info.protocol_version !== 'v11') throw new Error(`协议版本异常：${info.protocol_version}`);
    return `${info.app_name} ${info.app_version} / ${info.protocol_version}`;
  },
  '本地',
);

await check(
  'get_status（time 应 > 0，说明适配器跑了一会儿）',
  async () => {
    const status = data(await call(socket, 'get_status'));
    if (!status.online) throw new Error('online=false');
    return `online=${status.online} good=${status.good} time=${status.time}s`;
  },
  '本地',
);

await check(
  'get_login_info',
  async () => {
    const info = data(await call(socket, 'get_login_info'));
    if (values.self && String(info.user_id) !== values.self) {
      throw new Error(`账号不匹配：${info.user_id} != ${values.self}`);
    }
    return `uin=${info.user_id} nickname=${info.nickname}`;
  },
  'V35',
);

// ───────────────────────── 名单（V31）─────────────────────────

let friendCount = 0;
await check(
  'get_friend_list（0xfd4_1 分页 + 字段）',
  async () => {
    const list = data(await call(socket, 'get_friend_list'));
    friendCount = list.length;
    if (friendCount === 0) throw new Error('好友列表为空（分页可能没翻完）');
    const sample = list[0];
    for (const key of ['user_id', 'nickname', 'remark']) {
      if (!(key in sample)) throw new Error(`缺字段 ${key}：${JSON.stringify(sample)}`);
    }
    return `${friendCount} 个好友`;
  },
  'V31',
);

let groupCount = 0;
await check(
  'get_group_list（0xfe5_2）',
  async () => {
    const list = data(await call(socket, 'get_group_list'));
    groupCount = list.length;
    if (groupCount === 0) throw new Error('群列表为空');
    const sample = list[0];
    for (const key of ['group_id', 'group_name', 'member_count']) {
      if (!(key in sample)) throw new Error(`缺字段 ${key}`);
    }
    return `${groupCount} 个群`;
  },
  'V31',
);

const groupId = values.group
  ? Number(values.group)
  : data(await call(socket, 'get_group_list'))[0]?.group_id;

await check(
  'get_group_member_list（0xfe7_3 token 分页）',
  async () => {
    if (!groupId) throw SKIP;
    const members = data(await call(socket, 'get_group_member_list', { group_id: groupId }));
    if (members.length === 0) throw new Error('成员列表为空');
    const sample = members[0];
    for (const key of ['user_id', 'nickname', 'role', 'join_time', 'level']) {
      if (!(key in sample)) throw new Error(`缺字段 ${key}：${JSON.stringify(sample)}`);
    }
    return `群 ${groupId} 共 ${members.length} 人`;
  },
  'V31',
);

await check(
  'get_group_info',
  async () => {
    if (!groupId) throw SKIP;
    const info = data(await call(socket, 'get_group_info', { group_id: groupId }));
    return `${info.group_name}（${info.member_count}/${info.max_member_count}）`;
  },
  'V31',
);

// ───────────────────────── 资料（0xfe1_2）─────────────────────────

await check(
  'get_stranger_info（FetchUserProfile 0xfe1_2）',
  async () => {
    const target = values.peer ?? [...data(await call(socket, 'get_friend_list'))][0]?.user_id;
    if (!target) throw SKIP;
    const info = data(await call(socket, 'get_stranger_info', { user_id: Number(target) }));
    if (!info.nickname) throw new Error(`昵称为空：${JSON.stringify(info)}`);
    return `uin=${info.user_id} nick=${info.nickname} sex=${info.sex} age=${info.age}`;
  },
  '资料',
);

// ───────────────────────── 只读消息查询 ─────────────────────────

await check(
  'get_msg：订阅一分钟内应该至少有一条消息',
  async () => {
    const before = events.length;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      timer.unref?.();
      const tick = setInterval(() => {
        if (events.length > before) {
          clearTimeout(timer);
          clearInterval(tick);
          resolve();
        }
      }, 100);
      tick.unref?.();
    });
    // 只读场景没人发消息属正常：跳过而不是 FAIL（否则每次干净的环境都报红）。
    if (events.length === 0) throw SKIP;
    const message = events.find(
      (event) => event.post_type === 'message' || event.post_type === 'message_sent',
    );
    if (!message) throw new Error('收到事件但没有 message');
    const fetched = data(await call(socket, 'get_msg', { message_id: message.message_id }));
    if (!fetched.real_id) throw new Error('get_msg 缺少 real_id');
    return `message_id=${message.message_id} 可回查`;
  },
  'V35',
);

// ───────────────────────── 群管理（只读或幂等）─────────────────────────

await check(
  'set_group_whole_ban(false)（幂等写操作）',
  async () => {
    // --readonly：连幂等写也不做。它仍会向服务端提交一次群设置变更。
    if (values.readonly) throw SKIP;
    if (!groupId) throw SKIP;
    data(await call(socket, 'set_group_whole_ban', { group_id: groupId, enable: false }));
    return '已确认为「未全员禁言」';
  },
  '写',
);

// ───────────────────────── 会发消息的一组（--send）─────────────────────────

if (values.send) {
  const peer = values.peer ? Number(values.peer) : undefined;

  await check(
    'send_private_msg 纯文本',
    async () => {
      if (!peer) throw SKIP;
      const sent = data(
        await call(socket, 'send_private_msg', { user_id: peer, message: '[weqbot smoke] text' }),
      );
      if (!sent.message_id) throw new Error('没有返回 message_id');
      return `message_id=${sent.message_id}`;
    },
    'V35',
  );

  await check(
    'send_group_msg 纯文本',
    async () => {
      if (!groupId) throw SKIP;
      const sent = data(
        await call(socket, 'send_group_msg', { group_id: groupId, message: '[weqbot smoke] text' }),
      );
      return `message_id=${sent.message_id}`;
    },
    'V35',
  );

  await check(
    'send_group_msg 含 at / face',
    async () => {
      if (!groupId || !peer) throw SKIP;
      const message = [
        { type: 'at', data: { qq: String(peer) } },
        { type: 'text', data: { text: ' [weqbot smoke] at+face ' } },
        { type: 'face', data: { id: '14' } },
      ];
      data(await call(socket, 'send_group_msg', { group_id: groupId, message }));
      return '已发送';
    },
    'V48',
  );

  await check(
    'send_group_msg 图片（V32 出站媒体）',
    async () => {
      if (!groupId || !values['image-path']) throw SKIP;
      const message = [{ type: 'image', data: { file: values['image-path'] } }];
      data(await call(socket, 'send_group_msg', { group_id: groupId, message }));
      return `已发送 ${values['image-path']}`;
    },
    'V32',
  );

  await check(
    '私聊撤回（random 修复的验收点）',
    async () => {
      if (!peer) throw SKIP;
      const sent = data(
        await call(socket, 'send_private_msg', { user_id: peer, message: '[weqbot smoke] 待撤回' }),
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
      data(await call(socket, 'delete_msg', { message_id: sent.message_id }));
      return `message_id=${sent.message_id} 已撤回`;
    },
    'random',
  );

  await check(
    '群撤回',
    async () => {
      if (!groupId) throw SKIP;
      const sent = data(
        await call(socket, 'send_group_msg', {
          group_id: groupId,
          message: '[weqbot smoke] 待撤回',
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
      data(await call(socket, 'delete_msg', { message_id: sent.message_id }));
      return `message_id=${sent.message_id} 已撤回`;
    },
    'random',
  );
}

// ───────────────────────── 报告 ─────────────────────────

const pad = (value, width) => String(value).padEnd(width);
console.log('');
console.log(`${pad('结果', 6)} ${pad('用例', 44)} ${pad('V', 8)} 说明`);
console.log('─'.repeat(100));
for (const row of results) {
  console.log(`${pad(row.status, 6)} ${pad(row.name, 44)} ${pad(row.vTag ?? '', 8)} ${row.detail}`);
}

const failed = results.filter((row) => row.status === 'FAIL');
const skipped = results.filter((row) => row.status === 'SKIP');
console.log('');
console.log(
  `合计 ${results.length} 条：PASS ${results.length - failed.length - skipped.length}，` +
    `FAIL ${failed.length}，SKIP ${skipped.length}`,
);
if (!values.send) {
  console.log('（未加 --send：发送 / 撤回 / 图片相关的用例都没跑）');
}
console.log('');
console.log('仍需人工确认的 V 项：');
console.log('  V2/V33  从 QQ 本体发消息，确认机器人不同时收到自己那条（不回环）');
console.log('  V32     收一张群图 / 私聊图，看 image.url 能不能直接下载');
console.log('  V34     两台设备同时在线，看同一条消息是否重复投递');
console.log('  V30     `weqbot --print-capabilities --qq-pid <pid> --account <uin>` 比对 uid');
console.log('  V39     并发两个 openSession(mode=2)，只应有一个成功');

socket.close();
process.exit(failed.length > 0 ? 1 : 0);
