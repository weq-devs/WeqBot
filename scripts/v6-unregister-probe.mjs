/**
 * V6 专项：`UnRegister` 到底发没发、服务端认不认。
 *
 * 直接调 native，不经过 createBot / OneBot，把变量降到最少：
 *   login.db → quickLogin → openSession(mode 2) → 在线 15s → closeSession
 *
 * native 的日志只有在 `setLogPath` 之后才落盘，所以先开日志，再看
 * `/tmp/nt-native.log` 里的 `unregistered` / `UnRegister failed`。
 *
 * 用法：
 *   node scripts/v6-unregister-probe.mjs --uin <uin> --native <path>
 */

import { createRequire } from 'node:module';
import { existsSync, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    uin: { type: 'string' },
    native: { type: 'string' },
    'login-db': { type: 'string' },
    'log-path': { type: 'string', default: '/tmp/nt-native.log' },
    'hold-ms': { type: 'string', default: '15000' },
  },
});

const UIN = values.uin;
const NATIVE = values.native;
const LOGIN_DB = values['login-db'] ?? `${process.env.HOME}/.config/QQ/global/nt_db/login.db`;
const LOG_PATH = values['log-path'];
const HOLD_MS = Number(values['hold-ms']);

if (!UIN || !NATIVE) {
  console.error('需要 --uin 与 --native');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const nt = require(NATIVE);

// native 日志默认丢弃（只在 setLogPath 后写文件），不设的话看不到 UnRegister 结果。
if (existsSync(LOG_PATH)) rmSync(LOG_PATH);
nt.setLogPath(LOG_PATH);

const log = (msg, extra) =>
  console.log(
    `[${new Date().toISOString().slice(11, 23)}] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`,
  );

const probe = await nt.testDatabaseKey(LOGIN_DB, 'BD156D6710D54D8782F4');
if (!probe?.success) {
  console.error('login.db 解不开');
  process.exit(4);
}
const rows = nt.decryptLoginDb(LOGIN_DB, {
  pageHmacAlgorithm: probe.pageHmacAlgorithm,
  kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
});
const acc = rows.find((r) => r.uin === UIN);
if (!acc?.a1Payload) {
  console.error(`${LOGIN_DB} 里没有 ${UIN} 的可用 a1`);
  process.exit(5);
}

const major = nt.resolveAppidFromMajor(
  `${process.env.HOME}/.config/QQ/versions/3.2.35-54395/major.node`,
);
const wrapperPath = '/opt/QQ/resources/app/wrapper.node';

log('凭据就绪', { uin: acc.uin, uid: acc.uid });

const login = await nt.quickLogin({
  uin: acc.uin,
  a1: Buffer.from(acc.a1Payload, 'hex'),
  guid: acc.guid,
  uid: acc.uid,
  appId: 1600001615,
  subAppId: Number(major.appid),
  os: 'Linux',
  platform: 7,
  deviceName: 'weqbot-v6-probe',
  kernelVersion: 'weqbot-probe',
  qua: major.qua,
  clientVersion: `${major.version}-${major.build}`,
  wrapperPath,
});
log('quickLogin 成功');

const opened = await nt.openSession({
  session: {
    uin: acc.uin,
    a2: login.a2,
    d2: login.d2,
    d2Key: login.d2Key,
    guid: acc.guid,
    uid: login.uid ?? acc.uid,
    subAppId: Number(major.appid),
    clientVersion: `${major.version}-${major.build}`,
    qua: major.qua,
  },
  mode: 2,
  wrapperPath,
  device: {
    os: 'linux',
    appId: 1600001615,
    subAppId: Number(major.appid),
    qua: major.qua,
    clientVersion: `${major.version}-${major.build}`,
    deviceName: 'weqbot-v6-probe',
    kernelVersion: 'weqbot-probe',
  },
});
log('openSession 返回', opened);

log(`持有 ${HOLD_MS}ms（此时手机端应显示「电脑在线」）`);
await new Promise((resolve) => setTimeout(resolve, HOLD_MS));

log('>>> closeSession（应触发 UnRegister）');
const closed = await nt.closeSession(opened.sessionId, 'v6-probe-end');
log('closeSession 返回', { closed });

// 给 UnRegister 与 native 落盘留点时间（native 内部有 3s 超时）。
await new Promise((resolve) => setTimeout(resolve, 4000));

log(`native 日志：${LOG_PATH}`);
console.log('--- 与本实验相关的日志 ---');
const { readFileSync } = await import('node:fs');
let text = '';
try {
  text = readFileSync(LOG_PATH, 'utf8');
} catch {
  console.error('（没有 native 日志文件）');
  process.exit(0);
}
const lines = text
  .split('\n')
  .filter((line) => /unregister|UnRegister|register|heartbeat|session \d+/i.test(line));
if (lines.length === 0) {
  console.log('（没有匹配行；说明 UnRegister 分支没走到，或日志级别不够）');
} else {
  console.log(lines.slice(-25).join('\n'));
}
