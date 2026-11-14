/**
 * 抓「我们自己发的 UnRegister」到底长什么样。
 *
 * 在**同一个进程**里开 native debug 日志、跑 openSession → closeSession，
 * 把 close 期间发出去的 SSO 帧记下来。抓包只抓这一个包，避免噪声。
 *
 * 用法：
 *   node scripts/dump-unregister.mjs --uin <uin> --native <path>
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    uin: { type: 'string' },
    native: { type: 'string' },
    'login-db': { type: 'string' },
    'hold-ms': { type: 'string', default: '10000' },
    'out-dir': { type: 'string', default: '/tmp/unreg-dump' },
  },
});

const UIN = values.uin;
const NATIVE = values.native;
const LOGIN_DB = values['login-db'] ?? `${process.env.HOME}/.config/QQ/global/nt_db/login.db`;
const HOLD_MS = Number(values['hold-ms']);
const OUT = values['out-dir'];

if (!UIN || !NATIVE) {
  console.error('需要 --uin 与 --native');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const nt = require(NATIVE);

rmSync(OUT, { recursive: true, force: true });

const log = (msg, extra) =>
  console.log(
    `[${new Date().toISOString().slice(11, 23)}] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`,
  );

// native 日志只在 setLogPath 之后落盘；debug 级才能看到帧收发。
nt.setLogPath(`${OUT}/native.log`);
nt.setDebugLog(true);

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
  console.error(`没有 ${UIN} 的可用 a1`);
  process.exit(5);
}

const major = nt.resolveAppidFromMajor(
  `${process.env.HOME}/.config/QQ/versions/3.2.35-54395/major.node`,
);
const wrapperPath = '/opt/QQ/resources/app/wrapper.node';

log('quickLogin');
const login = await nt.quickLogin({
  uin: acc.uin,
  a1: Buffer.from(acc.a1Payload, 'hex'),
  guid: acc.guid,
  uid: acc.uid,
  appId: 1600001615,
  subAppId: Number(major.appid),
  os: 'Linux',
  platform: 7,
  deviceName: 'weqbot-test',
  kernelVersion: 'weqbot-test',
  qua: major.qua,
  clientVersion: `${major.version}-${major.build}`,
  wrapperPath,
});

log('openSession');
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
    deviceName: 'weqbot-test',
    kernelVersion: 'weqbot-test',
  },
});
log('在线', { sessionId: opened.sessionId, state: opened.state });

await new Promise((r) => setTimeout(r, HOLD_MS));

log('closeSession');
const closed = await nt.closeSession(opened.sessionId, 'dump-end');
log('closeSession 返回', { closed });

await new Promise((r) => setTimeout(r, 4000));

const logPath = `${OUT}/native.log`;
if (!existsSync(logPath)) {
  console.error('没有 native 日志');
  process.exit(0);
}
const text = readFileSync(logPath, 'utf8');
const lines = text.split('\n');
console.log('\n=== 含 unregister / 帧 / packet 的日志 ===');
const hits = lines.filter((l) => /unregister|UnRegister|send.*frame|packet|cmd=/i.test(l));
console.log(hits.slice(-40).join('\n') || '（无匹配）');
