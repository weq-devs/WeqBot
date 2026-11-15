/**
 * QQ 路径探测（W4）：只验纯函数在临时的假目录结构上能不能找对东西。
 *
 * 不碰真实 QQ 安装；三端布局的差异用目录结构模拟。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverQqPaths } from '../src/webui/qq-paths';

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'weqbot-qq-'));
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
