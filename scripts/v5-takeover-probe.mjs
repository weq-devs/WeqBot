/**
 * V5 真机实验：mode2 自建上线 vs QQ 本体在线 —— 谁会赢、谁被踢、之后会怎样。
 *
 * ⚠️ 这个脚本会用真实账号做「顶号」。它绕过 createBot 的 isQqLoggedIn 红线
 * （那条红线是产品保护，不是协议限制），直接调 native。
 *
 * 顺序：
 *   1. 记录 QQ 本体 pid / db 锁 / a1 指纹（sha256 前 8 位，不打印原文）
 *   2. 读 login.db 拿 a1 / guid / uid
 *   3. quickLogin(a1) —— 拿 a2/d2/d2Key
 *   4. openSession(mode 2) —— 注册，这就是「顶号」那一刻
 *   5. 每 2 秒采样：QQ 进程是否还活着、db 锁是否还在、本会话状态
 *   6. 到时间后 closeSession，再观察 QQ 是否会自己恢复
 *
 * 用法：
 *   node scripts/v5-takeover-probe.mjs --uin 10001 --native /tmp/weqbot-native/nt_helper.node
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    uin: { type: 'string' },
    native: { type: 'string' },
    'login-db': { type: 'string' },
    'msg-db': { type: 'string' },
    'hold-ms': { type: 'string', default: '20000' },
    'observe-after-close-ms': { type: 'string', default: '20000' },
  },
});

const UIN = values.uin;
const NATIVE = values.native;
const LOGIN_DB = values['login-db'] ?? `${process.env.HOME}/.config/QQ/global/nt_db/login.db`;
const MSG_DB = values['msg-db'];
const HOLD_MS = Number(values['hold-ms']);
const AFTER_MS = Number(values['observe-after-close-ms']);

if (!UIN || !NATIVE) {
  console.error('需要 --uin 与 --native');
  process.exit(2);
}
if (!MSG_DB) {
  console.error('需要 --msg-db（该账号的 nt_msg.db 绝对路径），否则没法判断 db 锁');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const nt = require(NATIVE);

const LOGIN_DB_KEY = 'BD156D6710D54D8782F4';
/** Linux 的 EasyLogin AppId / NTLoginPlatform（见 WeQ 的 APP_INFO 表）。 */
const APP_ID = 1600001615;
const PLATFORM = 7;
const OS = 'Linux';

const log = (msg, extra) =>
  console.log(
    `[${new Date().toISOString().slice(11, 23)}] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`,
  );

function sha8(hex) {
  return createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').slice(0, 8);
}

function qqAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function probeLock() {
  try {
    const probe = nt.probeDbLock(MSG_DB);
    const qqHolder = (probe.holders ?? []).find((h) => /qq/i.test(h.name));
    return { locked: probe.locked, qqHolder: qqHolder?.pid ?? null, holders: probe.holders ?? [] };
  } catch (error) {
    return { error: error.message };
  }
}

// ───────────────────── 1. 实验前快照 ─────────────────────

const before = probeLock();
const qqPid = before.qqHolder;
log('实验前', { qqPid, qqAlive: qqAlive(qqPid), dbLocked: before.locked });
if (!qqPid) {
  console.error('QQ 本体没持有该 db —— 这不是「顶号」实验，先让 QQ 登录。');
  process.exit(3);
}

// ───────────────────── 2. 读凭据 ─────────────────────

const probe = await nt.testDatabaseKey(LOGIN_DB, LOGIN_DB_KEY);
if (!probe?.success) {
  console.error('login.db 解不开');
  process.exit(4);
}
const rows = nt.decryptLoginDb(LOGIN_DB, {
  pageHmacAlgorithm: probe.pageHmacAlgorithm,
  kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
});
const account = rows.find((row) => row.uin === UIN);
if (!account?.a1Payload) {
  console.error(`login.db 里没有 ${UIN} 的可用 a1`);
  process.exit(5);
}

const subApp = nt.resolveAppidFromMajor(
  `${process.env.HOME}/.config/QQ/versions/3.2.35-54395/major.node`,
);
const wrapperPath = '/opt/QQ/resources/app/wrapper.node';
if (!existsSync(wrapperPath)) {
  console.error(`找不到 wrapper.node：${wrapperPath}`);
  process.exit(6);
}

log('凭据就绪', {
  uin: account.uin,
  userName: account.userName,
  a1: `sha256:${sha8(account.a1Payload)}…`,
  guid: account.guid,
  uid: account.uid,
  subAppId: subApp.appid,
  qua: subApp.qua,
});

// ───────────────────── 3. quickLogin ─────────────────────

log('quickLogin 开始（这一步是登录，不动在线状态）');
const login = await nt.quickLogin({
  uin: account.uin,
  a1: Buffer.from(account.a1Payload, 'hex'),
  guid: account.guid,
  uid: account.uid,
  appId: APP_ID,
  subAppId: Number(subApp.appid),
  os: OS,
  platform: PLATFORM,
  deviceName: 'weqbot-v5-probe',
  kernelVersion: process.release?.name ? 'weqbot-probe' : 'weqbot-probe',
  qua: subApp.qua,
  clientVersion: `${subApp.version}-${subApp.build}`,
  wrapperPath,
});
log('quickLogin 成功', {
  a2Len: login.a2?.length,
  d2Len: login.d2?.length,
  d2KeyLen: login.d2Key?.length,
  uid: login.uid,
  // a1 是否被服务端轮换：对比 hash 就知道
  a1Rotated: login.a1
    ? sha8(Buffer.from(login.a1).toString('hex')) !== sha8(account.a1Payload)
    : null,
});

// ───────────────────── 4. openSession(mode 2) —— 顶号 ─────────────────────

log('>>> openSession(mode 2)：开始顶号');
let opened;
try {
  opened = await nt.openSession({
    session: {
      uin: account.uin,
      a2: login.a2,
      d2: login.d2,
      d2Key: login.d2Key,
      guid: account.guid,
      uid: login.uid ?? account.uid,
      subAppId: Number(subApp.appid),
      clientVersion: `${subApp.version}-${subApp.build}`,
      qua: subApp.qua,
      // 注意：napi 的 `Option<String>` 只接受 `undefined`，传 `null` 会在类型
      // 转换阶段就抛（不是协议错误）。mode2 的 secToken 由 native 自己扫。
    },
    mode: 2,
    wrapperPath,
    device: {
      os: 'linux',
      appId: APP_ID,
      subAppId: Number(subApp.appid),
      qua: subApp.qua,
      clientVersion: `${subApp.version}-${subApp.build}`,
      deviceName: 'weqbot-v5-probe',
      kernelVersion: 'weqbot-probe',
    },
  });
  log('<<< openSession 返回：我们赢了', opened);
} catch (error) {
  log('<<< openSession 失败：QQ 守住了', { error: error.message });
  process.exit(10);
}

// ───────────────────── 5. 采样 ─────────────────────

const samples = [];
const sample = async (phase) => {
  const lock = probeLock();
  const alive = qqAlive(qqPid);
  let session = null;
  try {
    session = await nt.getSession(opened.sessionId);
  } catch {
    /* 会话没了 */
  }
  const row = {
    phase,
    t: Date.now(),
    qqAlive: alive,
    dbLocked: lock.locked,
    qqHolder: lock.qqHolder,
    state: session?.state ?? null,
    registered: session?.registered ?? null,
    synced: session?.synced ?? null,
  };
  samples.push(row);
  log('采样', row);
  return row;
};

await sample('t+0');
const deadline = Date.now() + HOLD_MS;
let kickedAt = null;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const row = await sample('hold');
  if (kickedAt === null && (row.qqAlive === false || row.qqHolder === null)) {
    kickedAt = row.t;
    log('>>> 检测到 QQ 侧发生变化');
  }
}

// ───────────────────── 6. 关闭并观察 ─────────────────────

log('closeSession（主动下线）');
try {
  await nt.closeSession(opened.sessionId, 'v5-probe-end');
} catch (error) {
  log('closeSession 报错', { error: error.message });
}
await sample('after-close');

const afterDeadline = Date.now() + AFTER_MS;
while (Date.now() < afterDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await sample('after-close');
}

// ───────────────────── 7. 结论 ─────────────────────

const qqEverDied = samples.some((s) => s.qqAlive === false);
const lockEverLost = samples.some((s) => s.qqHolder === null);
const sessionWon = samples.some((s) => s.state === 'online');

console.log('');
console.log('══════════ V5 结论 ══════════');
console.log(`mode2 是否成功注册：        ${sessionWon ? '是' : '否'}`);
console.log(`QQ 进程是否被踢（退出）：   ${qqEverDied ? '是' : '否'}`);
console.log(`QQ 是否失去 db 锁：         ${lockEverLost ? '是' : '否'}`);
console.log(
  `首次检测到变化的时间：      ${kickedAt ? `+${Math.round((kickedAt - samples[0].t) / 1000)}s` : '无'}`,
);
console.log(`关会话后 QQ 是否恢复：      ${samples.at(-1)?.qqHolder ? '是（重新持锁）' : '否'}`);
console.log('');
console.log('注意：QQ 进程没退出 ≠ 没被踢。要看 QQ 界面是否回到登录页。');
console.log('如果 QQ 只是掉线没退出，进程和 db 锁都可能还在。');
