/**
 * 用户手填路径的归一化。
 *
 * 重点在**跨平台路径串**：本机（Linux）必须能正确处理 Windows 的 `D:\...`，
 * 所以这里大量用 `path.win32` 构造期望值。
 */

import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import test from 'node:test';
import {
  looksAbsolutePath,
  normalizeQqDataRoot,
  normalizeQqInstallDir,
  type NormalizeFs,
} from '../src/webui/qq-normalize';

/** 只声明「磁盘上有什么」的假 fs。 */
function fakeFs(entries: Record<string, 'file' | 'dir'>): NormalizeFs {
  return {
    exists: (path) => path in entries,
    isFile: (path) => entries[path] === 'file',
  };
}

const EMPTY = fakeFs({});

test('looksAbsolutePath：三端的绝对路径都认，相对路径不认', () => {
  assert.equal(looksAbsolutePath('C:\\Program Files\\Tencent\\QQNT'), true);
  assert.equal(looksAbsolutePath('\\\\server\\share\\QQ'), true);
  assert.equal(looksAbsolutePath('/opt/QQ'), true);
  assert.equal(looksAbsolutePath('QQ'), false);
  assert.equal(looksAbsolutePath('./QQ'), false);
  assert.equal(looksAbsolutePath('opt/QQ'), false);
  assert.equal(looksAbsolutePath('D:QQData'), false);
});

test('数据根：去掉尾分隔符', () => {
  assert.equal(normalizeQqDataRoot('/home/me/.config/QQ/', 'linux', EMPTY), '/home/me/.config/QQ');
  assert.equal(
    normalizeQqDataRoot('D:\\QQData\\\\', 'win32', EMPTY),
    'D:\\QQData',
    'Windows 的反斜杠尾缀也要剥干净',
  );
});

test('数据根：裸盘根原样保留（剥掉会变成驱动器相对路径）', () => {
  assert.equal(normalizeQqDataRoot('D:\\', 'win32', EMPTY), 'D:\\');
  assert.equal(normalizeQqDataRoot('d:/', 'win32', EMPTY), 'd:/');
});

test('数据根：选到 win32 的 <uin> 账户目录时上跳一层', () => {
  const fs = fakeFs({
    'D:\\QQData\\123456': 'dir',
    'D:\\QQData\\123456\\nt_qq\\nt_db': 'dir',
    'D:\\QQData': 'dir',
  });
  assert.equal(normalizeQqDataRoot('D:\\QQData\\123456', 'win32', fs), 'D:\\QQData');
});

test('数据根：数据根本身叫 "1234" 时不能被当作账户目录', () => {
  // 根旁边有 `nt_qq/global`，账户目录没有 —— 这是 WeQ 用来消歧的那条规则。
  const fs = fakeFs({
    'D:\\1234': 'dir',
    'D:\\1234\\nt_qq\\nt_db': 'dir',
    'D:\\1234\\nt_qq\\global': 'dir',
  });
  assert.equal(normalizeQqDataRoot('D:\\1234', 'win32', fs), 'D:\\1234');
});

test('数据根：选到 unix 的 nt_qq_<hash> 账户目录时上跳一层', () => {
  const account = '/home/me/.config/QQ/nt_qq_2472b597abc';
  const fs = fakeFs({ [account]: 'dir', [`${account}/nt_db`]: 'dir' });
  assert.equal(normalizeQqDataRoot(account, 'linux', fs), '/home/me/.config/QQ');
});

test('数据根：普通目录名不做任何猜测（QQ 允许任意搬移）', () => {
  const fs = fakeFs({ '/mnt/backup/QQ数据': 'dir' });
  assert.equal(normalizeQqDataRoot('/mnt/backup/QQ数据', 'linux', fs), '/mnt/backup/QQ数据');
});

test('安装根：可执行文件 → 所在目录', () => {
  const fs = fakeFs({ '/opt/QQ/qq': 'file' });
  assert.equal(normalizeQqInstallDir('/opt/QQ/qq', 'linux', fs), '/opt/QQ');
  assert.equal(
    normalizeQqInstallDir('/opt/QQ/qq', 'linux', EMPTY),
    '/opt/QQ',
    '文件不存在也按文件名形状处理',
  );
});

test('安装根：Linux 的 resources/app → 安装根', () => {
  assert.equal(normalizeQqInstallDir('/opt/QQ/resources/app', 'linux', EMPTY), '/opt/QQ');
});

test('安装根：Windows 的 versions/<v>/resources/app → 安装根', () => {
  const appDir = win32.join(
    'C:\\Program Files\\Tencent\\QQNT',
    'versions',
    '9.9.9',
    'resources',
    'app',
  );
  assert.equal(normalizeQqInstallDir(appDir, 'win32', EMPTY), 'C:\\Program Files\\Tencent\\QQNT');
});

test('安装根：Windows 的 versions/<v> → 安装根', () => {
  const versionDir = win32.join('C:\\Program Files\\Tencent\\QQNT', 'versions', '9.9.9');
  assert.equal(
    normalizeQqInstallDir(versionDir, 'win32', EMPTY),
    'C:\\Program Files\\Tencent\\QQNT',
  );
});

test('安装根：macOS 的 .app/Contents/Resources/app → .app', () => {
  assert.equal(
    normalizeQqInstallDir('/Applications/QQ.app/Contents/Resources/app', 'darwin', EMPTY),
    '/Applications/QQ.app',
  );
});

test('安装根：macOS 的 .app 本身保持不动', () => {
  assert.equal(
    normalizeQqInstallDir('/Applications/QQ.app', 'darwin', EMPTY),
    '/Applications/QQ.app',
  );
});

test('安装根：已经是安装根时原样返回', () => {
  assert.equal(normalizeQqInstallDir('/opt/QQ', 'linux', EMPTY), '/opt/QQ');
  assert.equal(
    normalizeQqInstallDir('C:\\Program Files\\Tencent\\QQNT', 'win32', EMPTY),
    'C:\\Program Files\\Tencent\\QQNT',
  );
});
