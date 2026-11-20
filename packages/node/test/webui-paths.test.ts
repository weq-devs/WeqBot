/**
 * QQ 路径探测（W4）：只验纯函数在临时的假目录结构上能不能找对东西。
 *
 * 不碰真实 QQ 安装；三端布局的差异用目录结构模拟。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { QqHints } from '../src/webui/qq-detect';
import { discoverQqPaths, verifyFileOptionsFor } from '../src/webui/qq-paths';

/** 所有 fixture 都登记在这里，`after` 一次性清掉。 */
const fixtures: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'weqbot-qq-'));
  fixtures.push(root);
  return root;
}

process.on('exit', () => {
  for (const root of fixtures) void rm(root, { recursive: true, force: true });
});

function hintsOf(patch: Partial<QqHints>): QqHints {
  return { installDir: null, protocolExe: null, spotlightApp: null, sources: {}, ...patch };
}

test('Linux 布局：数据根 / 两个 login.db / 安装目录 / wrapper / major', async () => {
  const root = await fixture();
  const dataRoot = join(root, 'QQ');
  await mkdir(join(dataRoot, 'global', 'nt_db'), { recursive: true });
  await mkdir(join(dataRoot, 'nt_qq', 'global', 'nt_db'), { recursive: true });
  await writeFile(join(dataRoot, 'global', 'nt_db', 'login.db'), 'x');
  await writeFile(join(dataRoot, 'nt_qq', 'global', 'nt_db', 'login.db'), 'y');

  const install = join(root, 'qq-install');
  await mkdir(join(install, 'resources', 'app'), { recursive: true });
  await writeFile(join(install, 'qq'), '');
  await writeFile(join(install, 'resources', 'app', 'wrapper.node'), '');
  await writeFile(join(install, 'resources', 'app', 'major.node'), '');

  const previousRoot = process.env.WEQBOT_QQ_ROOT;
  const previousExe = process.env.WEQBOT_QQ_EXE;
  process.env.WEQBOT_QQ_ROOT = dataRoot;
  process.env.WEQBOT_QQ_EXE = join(install, 'qq');
  try {
    const paths = discoverQqPaths('linux', root);
    assert.equal(paths.dataRoot, dataRoot);
    assert.deepEqual(paths.loginDbs, [
      join(dataRoot, 'global', 'nt_db', 'login.db'),
      join(dataRoot, 'nt_qq', 'global', 'nt_db', 'login.db'),
    ]);
    assert.equal(paths.qqExe, join(install, 'qq'));
    assert.equal(paths.wrapperNode, join(install, 'resources', 'app', 'wrapper.node'));
    assert.equal(paths.majorNode, join(install, 'resources', 'app', 'major.node'));
  } finally {
    restore('WEQBOT_QQ_ROOT', previousRoot);
    restore('WEQBOT_QQ_EXE', previousExe);
  }
});

test('macOS 布局：数据根在容器里，安装目录多一层 Contents', async () => {
  const root = await fixture();
  const dataRoot = join(
    root,
    'Library',
    'Containers',
    'com.tencent.qq',
    'Data',
    'Library',
    'Application Support',
    'QQ',
  );
  await mkdir(join(dataRoot, 'global', 'nt_db'), { recursive: true });
  await writeFile(join(dataRoot, 'global', 'nt_db', 'login.db'), 'x');

  const app = join(root, 'Applications', 'QQ.app');
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
  await mkdir(join(app, 'Contents', 'Resources', 'app'), { recursive: true });
  await writeFile(join(app, 'Contents', 'MacOS', 'QQ'), '');
  await writeFile(join(app, 'Contents', 'Resources', 'app', 'wrapper.node'), '');

  const previousRoot = process.env.WEQBOT_QQ_ROOT;
  const previousExe = process.env.WEQBOT_QQ_EXE;
  delete process.env.WEQBOT_QQ_ROOT;
  delete process.env.WEQBOT_QQ_EXE;
  process.env.WEQBOT_QQ_EXE = join(app, 'Contents', 'MacOS', 'QQ');
  try {
    const paths = discoverQqPaths('darwin', root);
    assert.equal(paths.dataRoot, dataRoot);
    // macOS 的 `resources/app` 在 `Contents/Resources/app`，从可执行文件往上三层的根算。
    assert.equal(paths.wrapperNode, join(app, 'Contents', 'Resources', 'app', 'wrapper.node'));
  } finally {
    restore('WEQBOT_QQ_ROOT', previousRoot);
    restore('WEQBOT_QQ_EXE', previousExe);
  }
});

test('Windows 布局：login.db 在 nt_qq 下，版本目录来自 config.json', async () => {
  const root = await fixture();
  const dataRoot = join(root, 'Tencent Files');
  await mkdir(join(dataRoot, 'nt_qq', 'global', 'nt_db'), { recursive: true });
  await writeFile(join(dataRoot, 'nt_qq', 'global', 'nt_db', 'login.db'), 'x');

  const qqRoot = join(root, 'QQ');
  const versionDir = join(qqRoot, 'versions', '9.9.9');
  await mkdir(join(versionDir, 'resources', 'app'), { recursive: true });
  await writeFile(join(qqRoot, 'QQ.exe'), '');
  await writeFile(join(versionDir, 'resources', 'app', 'wrapper.node'), '');
  await writeFile(join(versionDir, 'resources', 'app', 'major.node'), '');
  await writeFile(join(qqRoot, 'versions', 'config.json'), JSON.stringify({ curVersion: '9.9.9' }));

  const previousRoot = process.env.WEQBOT_QQ_ROOT;
  const previousExe = process.env.WEQBOT_QQ_EXE;
  process.env.WEQBOT_QQ_ROOT = dataRoot;
  process.env.WEQBOT_QQ_EXE = join(qqRoot, 'QQ.exe');
  try {
    const paths = discoverQqPaths('win32', root);
    assert.equal(paths.dataRoot, dataRoot);
    assert.deepEqual(paths.loginDbs, [join(dataRoot, 'nt_qq', 'global', 'nt_db', 'login.db')]);
    assert.equal(paths.wrapperNode, join(versionDir, 'resources', 'app', 'wrapper.node'));
  } finally {
    restore('WEQBOT_QQ_ROOT', previousRoot);
    restore('WEQBOT_QQ_EXE', previousExe);
  }
});

test('Windows：UserDataSavePathType 决定数据根（2=自定义 / 1=Tencent Files / 其它=QQ）', async () => {
  // `<home>/../Public/.../UserDataInfo.ini` 是 QQ 记录的保存设置：type=2 才认
  // savePath；1 是 Documents/Tencent Files；其余（含 0、3、字段缺失）是旧版
  // Documents/QQ —— 重装系统后历史记录仍留在那里的情况就是这一种。
  const cases: Array<{ type: string | null; dir: 'custom' | 'Tencent Files' | 'QQ' }> = [
    { type: '2', dir: 'custom' },
    { type: '1', dir: 'Tencent Files' },
    { type: '0', dir: 'QQ' },
    { type: '3', dir: 'QQ' },
    { type: null, dir: 'QQ' },
  ];
  for (const { type, dir } of cases) {
    const base = await fixture();
    const home = join(base, 'home');
    const custom = join(base, 'custom-data');
    const expected = dir === 'custom' ? custom : join(home, 'Documents', dir);
    await mkdir(expected, { recursive: true });
    const iniDir = join(base, 'Public', 'Documents', 'Tencent', 'QQ');
    await mkdir(iniDir, { recursive: true });
    await writeFile(
      join(iniDir, 'UserDataInfo.ini'),
      [
        '[UserDataSet]',
        ...(type === null ? [] : [`UserDataSavePathType=${type}`]),
        `UserDataSavePath=${custom}`,
      ].join('\r\n'),
    );

    const previousRoot = process.env.WEQBOT_QQ_ROOT;
    delete process.env.WEQBOT_QQ_ROOT;
    try {
      // 旧签名：Linux 上模拟 Windows 布局时用 POSIX 方言拼串。
      const paths = discoverQqPaths('win32', home);
      assert.equal(paths.dataRoot, expected, `type=${String(type)}`);
    } finally {
      restore('WEQBOT_QQ_ROOT', previousRoot);
    }
  }
});

test('数据根与 login.db 找不到时返回 null / 空数组，不抛错', async () => {
  // 安装目录会命中本机真实路径（`/opt/QQ/qq` 等固定候选），所以这里只断言
  // 数据侧 —— 「什么都没装」在装了 QQ 的开发机上不是可复现的前提。
  const root = await fixture();
  const previousRoot = process.env.WEQBOT_QQ_ROOT;
  delete process.env.WEQBOT_QQ_ROOT;
  try {
    const paths = discoverQqPaths('linux', root);
    assert.equal(paths.dataRoot, null);
    assert.deepEqual(paths.loginDbs, []);
  } finally {
    restore('WEQBOT_QQ_ROOT', previousRoot);
  }
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// ─────────────────── 覆盖来源 / 新探测路径 ───────────────────

test('安装根：WEQBOT_QQ_INSTALL_DIR 能定位；WEQBOT_QQ_ROOT 只管数据根', async () => {
  const root = await fixture();
  const install = join(root, 'qq-install');
  await mkdir(join(install, 'resources', 'app'), { recursive: true });
  await writeFile(join(install, 'qq'), '');
  await writeFile(join(install, 'resources', 'app', 'wrapper.node'), '');

  const dataRoot = join(root, 'qq-data');
  await mkdir(dataRoot, { recursive: true });

  const paths = discoverQqPaths({
    platform: 'linux',
    home: root,
    env: { WEQBOT_QQ_INSTALL_DIR: install, WEQBOT_QQ_ROOT: dataRoot },
    hints: hintsOf({}),
    pathStyle: 'posix',
  });

  assert.equal(paths.dataRoot, dataRoot, 'WEQBOT_QQ_ROOT 只影响数据根');
  assert.equal(paths.installRoot, install);
  assert.equal(paths.sources.dataRoot, 'env');
  assert.equal(paths.sources.qqExe, 'env');
});

test('安装根：WEQBOT_QQ_ROOT 不会被当成安装根', async () => {
  const root = await fixture();
  // 造一份「数据根里也有 qq 可执行文件」的布局：如果实现把数据根当安装根，
  // 就会返回这个 exe；正确实现应该忽略它。
  const dataRoot = join(root, 'qq-data');
  await mkdir(join(dataRoot, 'resources', 'app'), { recursive: true });
  await writeFile(join(dataRoot, 'qq'), '');

  const paths = discoverQqPaths({
    platform: 'linux',
    home: join(root, 'nowhere'),
    env: { WEQBOT_QQ_ROOT: dataRoot },
    hints: hintsOf({}),
    pathStyle: 'posix',
  });

  assert.equal(paths.dataRoot, dataRoot);
  assert.notEqual(paths.qqExe, join(dataRoot, 'qq'), '这是第 1 项修复：数据根不再被当成安装根');
  assert.notEqual(paths.sources.qqExe, 'env', '数据根来源不该污染安装根来源');
});

test('覆盖优先级：配置文件 > 环境变量 > 自动探测', async () => {
  const root = await fixture();
  const fromOverride = join(root, 'override-install');
  const fromEnv = join(root, 'env-install');
  for (const dir of [fromOverride, fromEnv]) {
    await mkdir(join(dir, 'resources', 'app'), { recursive: true });
    await writeFile(join(dir, 'qq'), '');
    await writeFile(join(dir, 'resources', 'app', 'wrapper.node'), '');
  }

  const overrideData = join(root, 'override-data');
  const envData = join(root, 'env-data');
  await mkdir(overrideData, { recursive: true });
  await mkdir(envData, { recursive: true });

  const paths = discoverQqPaths({
    platform: 'linux',
    home: root,
    env: { WEQBOT_QQ_INSTALL_DIR: fromEnv, WEQBOT_QQ_ROOT: envData },
    overrides: { installDir: fromOverride, dataDir: overrideData },
    hints: hintsOf({}),
    pathStyle: 'posix',
  });

  assert.equal(paths.installRoot, fromOverride);
  assert.equal(paths.dataRoot, overrideData);
  assert.equal(paths.sources.qqExe, 'override');
  assert.equal(paths.sources.dataRoot, 'override');
});

test('数据根覆盖：用户选到 nt_qq_<hash> 账户目录时自动上跳', async () => {
  const root = await fixture();
  const dataRoot = join(root, 'QQ');
  const accountDir = join(dataRoot, 'nt_qq_0123456789abcdef0123456789abcdef');
  await mkdir(join(accountDir, 'nt_db'), { recursive: true });

  const paths = discoverQqPaths({
    platform: 'linux',
    home: root,
    env: {},
    overrides: { dataDir: accountDir },
    hints: hintsOf({}),
    pathStyle: 'posix',
  });

  assert.equal(paths.dataRoot, dataRoot);
});

test('login.db 顺序是 segment-major：primary 永远排在 supplementary 前面', async () => {
  const root = await fixture();
  // 第一个根只有 secondary，第二个根有 primary。
  const rootA = join(root, 'a');
  const rootB = join(root, 'b');
  await mkdir(join(rootA, 'nt_qq', 'global', 'nt_db'), { recursive: true });
  await mkdir(join(rootB, 'global', 'nt_db'), { recursive: true });
  await writeFile(join(rootA, 'nt_qq', 'global', 'nt_db', 'login.db'), 'secondary');
  await writeFile(join(rootB, 'global', 'nt_db', 'login.db'), 'primary');

  const paths = discoverQqPaths({
    platform: 'linux',
    home: root,
    env: { WEQBOT_QQ_ROOT: rootA },
    overrides: { dataDir: rootB },
    hints: hintsOf({}),
    pathStyle: 'posix',
  });

  assert.deepEqual(
    paths.loginDbs,
    [
      join(rootB, 'global', 'nt_db', 'login.db'),
      join(rootA, 'nt_qq', 'global', 'nt_db', 'login.db'),
    ],
    'primary 必须在 supplementary 之前，否则 dedupeByUin 会用错行',
  );
});

// Windows 布局在本机只能用 POSIX 字符串模拟：`win32.join` 造出来的 `\tmp\...`
// 在 Linux 上会变成仓库根下的字面反斜杠目录，`existsSync` 也就对不上了。
// `pathStyle: 'posix'` 让拼路径与磁盘探测都用真实存在的 POSIX fixture，
// 布局规则（`versions/<v>/resources/app`）本身由 `platform: 'win32'` 决定。
test('Windows 协议处理器锚定：没有 versions/config.json 也能定位', async () => {
  const root = await fixture();
  const qqRoot = join(root, 'QQ');
  const appDir = join(qqRoot, 'versions', '9.9.9', 'resources', 'app');
  await mkdir(appDir, { recursive: true });
  await writeFile(join(qqRoot, 'QQ.exe'), '');
  await writeFile(join(appDir, 'timwp.exe'), '');
  await writeFile(join(appDir, 'wrapper.node'), '');
  await writeFile(join(appDir, 'major.node'), '');

  const paths = discoverQqPaths({
    platform: 'win32',
    pathStyle: 'posix',
    home: root,
    env: {},
    hints: hintsOf({
      protocolExe: join(appDir, 'timwp.exe'),
      sources: { installDir: 'protocol' },
    }),
  });

  assert.equal(paths.installRoot, qqRoot);
  assert.equal(paths.appDir, appDir);
  assert.equal(paths.qqExe, join(qqRoot, 'QQ.exe'));
  assert.equal(paths.majorNode, join(appDir, 'major.node'));
  assert.equal(paths.sources.qqExe, 'protocol');
});

test('Windows 注册表兜底：没有协议处理器时用 UninstallString 推出的安装根', async () => {
  const root = await fixture();
  const qqRoot = join(root, 'QQ');
  const appDir = join(qqRoot, 'versions', '9.9.9', 'resources', 'app');
  await mkdir(appDir, { recursive: true });
  await writeFile(join(qqRoot, 'QQ.exe'), '');
  await writeFile(join(appDir, 'wrapper.node'), '');

  const paths = discoverQqPaths({
    platform: 'win32',
    pathStyle: 'posix',
    home: root,
    env: {},
    hints: hintsOf({ installDir: qqRoot, sources: { installDir: 'registry' } }),
  });

  assert.equal(paths.installRoot, qqRoot);
  assert.equal(paths.sources.qqExe, 'registry');
});

test('macOS Spotlight：静态候选都没有时靠 mdfind 结果', async () => {
  const root = await fixture();
  const app = join(root, 'QQ.app');
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
  await mkdir(join(app, 'Contents', 'Resources', 'app'), { recursive: true });
  await writeFile(join(app, 'Contents', 'MacOS', 'QQ'), '');
  await writeFile(join(app, 'Contents', 'Resources', 'app', 'wrapper.node'), '');

  const paths = discoverQqPaths({
    platform: 'darwin',
    home: join(root, 'nohome'),
    env: {},
    hints: hintsOf({ spotlightApp: app, sources: { installDir: 'spotlight' } }),
  });

  assert.equal(paths.installRoot, app);
  assert.equal(paths.sources.qqExe, 'spotlight');
});

test('版本：优先读 resources/app/package.json', async () => {
  const root = await fixture();
  const install = join(root, 'qq-install');
  await mkdir(join(install, 'resources', 'app'), { recursive: true });
  await writeFile(join(install, 'qq'), '');
  await writeFile(
    join(install, 'resources', 'app', 'package.json'),
    JSON.stringify({ version: '3.2.35-54395' }),
  );

  const paths = discoverQqPaths({
    platform: 'linux',
    home: root,
    env: { WEQBOT_QQ_INSTALL_DIR: install },
    hints: hintsOf({}),
    pathStyle: 'posix',
  });

  assert.equal(paths.version, '3.2.35-54395');
});

test('版本：package.json 缺失时是 null，不影响其它字段', async () => {
  const root = await fixture();
  const install = join(root, 'qq-install');
  await mkdir(join(install, 'resources', 'app'), { recursive: true });
  await writeFile(join(install, 'qq'), '');

  const paths = discoverQqPaths({
    platform: 'linux',
    home: root,
    env: { WEQBOT_QQ_INSTALL_DIR: install },
    hints: hintsOf({}),
    pathStyle: 'posix',
  });

  assert.equal(paths.version, null);
  assert.equal(paths.installRoot, install);
});

test('安装根覆盖可以是 resources/app，归一化回安装根', async () => {
  const root = await fixture();
  const install = join(root, 'QQ');
  const appDir = join(install, 'resources', 'app');
  await mkdir(appDir, { recursive: true });
  await writeFile(join(install, 'qq'), '');
  await writeFile(join(appDir, 'wrapper.node'), '');

  const paths = discoverQqPaths({
    platform: 'linux',
    home: root,
    env: {},
    overrides: { installDir: appDir },
    hints: hintsOf({}),
    pathStyle: 'posix',
  });

  assert.equal(paths.installRoot, install);
  assert.equal(paths.appDir, appDir);
  assert.equal(paths.sources.qqExe, 'override');
});

test('verify_file：按探测到的 resources/app 拼三端路径，标记跟着真实存在的文件走', async () => {
  const root = await fixture();
  const install = join(root, 'QQ');
  const appDir = join(install, 'resources', 'app');
  await mkdir(join(appDir, 'application.asar'), { recursive: true });
  await mkdir(join(appDir, 'app_launcher'), { recursive: true });
  await writeFile(join(install, 'qq'), '');
  // 只有 wrapper.node 与 package.json 存在；application.asar 目录不算、「文件」。
  await writeFile(join(appDir, 'wrapper.node'), '');
  await writeFile(join(appDir, 'package.json'), '{"version":"3.2.35"}');

  const paths = discoverQqPaths({
    platform: 'linux',
    home: root,
    env: {},
    overrides: { installDir: install },
    hints: hintsOf({}),
    pathStyle: 'posix',
  });
  const verify = verifyFileOptionsFor(paths);
  assert.ok(verify);
  // 13 条，顺序与抓包一致；第一项是 app_launcher。
  assert.equal(verify.paths?.length, 13);
  assert.equal(verify.paths?.[0], join(appDir, 'app_launcher', 'index.js'));
  assert.equal(verify.paths?.[12], join(appDir, 'application.asar', 'node-plugin.background.js'));
  // 标记顺序 application.asar / major.node / package.json / wrapper.node；
  // `application.asar` 是目录，但**存在即报「1」**（native 同一条规则）。
  assert.deepEqual(verify.fileMarks, ['1', '0', '1', '1']);
  assert.equal(verify.binaryPath, join(install, 'qq'));
});

test('verify_file：Windows 用反斜杠拼，且探不到安装目录时整项省略', async () => {
  const root = await fixture();
  const qqRoot = join(root, 'QQ');
  const versionDir = join(qqRoot, 'versions', '9.9.9');
  const appDir = join(versionDir, 'resources', 'app');
  await mkdir(appDir, { recursive: true });
  await writeFile(join(qqRoot, 'QQ.exe'), '');
  await writeFile(join(appDir, 'major.node'), '');

  const paths = discoverQqPaths({
    platform: 'win32',
    home: root,
    env: {},
    overrides: { exe: join(qqRoot, 'QQ.exe') },
    hints: hintsOf({}),
    // 在 Linux 上模拟 Windows 布局：字符串是 POSIX 形态，用 posix 方言拼。
    pathStyle: 'posix',
  });
  const verify = verifyFileOptionsFor(paths);
  assert.ok(verify);
  assert.equal(verify.paths?.[0], join(appDir, 'app_launcher', 'index.js'));
  assert.deepEqual(verify.fileMarks, ['0', '1', '0', '0']);

  // 真实 Windows 的 `appDir` 是反斜杠串，拼出来也必须是反斜杠。
  const win = verifyFileOptionsFor({
    ...paths,
    appDir: 'C:\\Program Files\\Tencent\\QQNT\\versions\\9.9.9\\resources\\app',
  });
  assert.equal(
    win?.paths?.[0],
    'C:\\Program Files\\Tencent\\QQNT\\versions\\9.9.9\\resources\\app\\app_launcher\\index.js',
  );

  // 没有 `appDir`（QQ 没装 / 没探到）：不猜，交给 native 的平台默认。
  assert.equal(
    verifyFileOptionsFor({ ...paths, appDir: null, qqExe: null, wrapperNode: null }),
    undefined,
  );
});
