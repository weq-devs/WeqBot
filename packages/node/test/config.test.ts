/**
 * `--config` 的加载与合并。
 *
 * 这里刻意覆盖错误路径多于成功路径：配置文件是用户手写的，**静默失效的代价
 * 远大于报错**（`oneBot` 拼错成 `onebotByUin` 时会「配置看起来生效了但适配器没起」）。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConfigError, loadConfigFile, mergeConfig } from '../src/config';
import { saveOneBotConfig } from '../src/webui/config-file';

async function withFile(content: string, run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'weqbot-config-'));
  const path = join(dir, 'config.json');
  try {
    await writeFile(path, content, 'utf8');
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const EMPTY_NETWORKS = {
  networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
};

test('读一份完整配置', async () => {
  const body = JSON.stringify({
    native: { wrapperPath: '/opt/QQ/wrapper.node' },
    qq: { dbPath: '/opt/QQ/nt_msg.db' },
    session: { syncGraceMs: 30_000 },
    secToken: { rotateMs: 3_600_000 },
    onebotByUin: { '2863253201': EMPTY_NETWORKS },
    log: { level: 'debug' },
    keepRaw: true,
  });
  await withFile(body, async (path) => {
    const config = await loadConfigFile(path);
    assert.equal(config.native?.wrapperPath, '/opt/QQ/wrapper.node');
    assert.equal(config.session?.syncGraceMs, 30_000);
    assert.equal(config.keepRaw, true);
  });
});

test('凭据字段一律拒绝（比静默忽略更安全）', async () => {
  for (const key of ['a1', 'uid', 'guid', 'd2Key']) {
    await withFile(JSON.stringify({ [key]: 'x' }), async (path) => {
      await assert.rejects(loadConfigFile(path), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, new RegExp(key));
        assert.match(error.message, /CredentialVault/);
        return true;
      });
    });
  }
});

test('拼错的顶层键报错，并列出可用键', async () => {
  await withFile(JSON.stringify({ oneBot: EMPTY_NETWORKS }), async (path) => {
    await assert.rejects(loadConfigFile(path), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /oneBot/);
      assert.match(error.message, /onebot/); // 可用键列表里要有正确的拼写
      return true;
    });
  });
});

test('onebotByUin.networks 四类数组缺一不可', async () => {
  await withFile(
    JSON.stringify({
      onebotByUin: {
        '2863253201': { networks: { httpServers: [], httpClients: [], wsServers: [] } },
      },
    }),
    async (path) => {
      await assert.rejects(loadConfigFile(path), /wsClients/);
    },
  );

  await withFile(JSON.stringify({ onebotByUin: { '2863253201': {} } }), async (path) => {
    await assert.rejects(loadConfigFile(path), /networks/);
  });

  await withFile(JSON.stringify({ onebotByUin: { 'not-a-uin': EMPTY_NETWORKS } }), async (path) => {
    await assert.rejects(loadConfigFile(path), /不是合法 QQ 号/);
  });
});

test('不是合法 JSON / 顶层不是对象 / 文件不存在都要说清楚', async () => {
  await withFile('{ not json', async (path) => {
    await assert.rejects(loadConfigFile(path), /不是合法 JSON/);
  });
  await withFile('[1, 2]', async (path) => {
    await assert.rejects(loadConfigFile(path), /顶层必须是对象/);
  });
  await assert.rejects(
    loadConfigFile(join(tmpdir(), 'weqbot-definitely-missing.json')),
    /读不到文件/,
  );
});

test('mergeConfig：命令行覆盖配置文件，账号只认 --account', () => {
  const merged = mergeConfig({
    file: {
      qq: { dbPath: '/from/file.db' },
      onebotByUin: { '2863253201': EMPTY_NETWORKS },
      log: { level: 'warn' },
    },
    uin: '2863253201',
    qqDbPath: '/from/cli.db',
  });

  assert.equal(merged.account.uin, '2863253201');
  assert.equal(merged.qq?.dbPath, '/from/cli.db', '命令行优先');
  assert.deepEqual(merged.onebot, EMPTY_NETWORKS, '当前账号的 OneBot 配置要被选中');
  assert.equal(merged.log?.level, 'warn');
});

test('mergeConfig：只选当前账号的 OneBot 配置', () => {
  const merged = mergeConfig({
    file: {
      onebotByUin: {
        '10001': EMPTY_NETWORKS,
        '10002': { ...EMPTY_NETWORKS, qzone: false },
      },
    },
    uin: '10002',
  });
  assert.equal(merged.onebot?.qzone, false);
  assert.equal(mergeConfig({ file: {}, uin: '10003' }).onebot, undefined);
});

test('saveOneBotConfig：按 uin 写入，不碰其它账号与顶层键', async () => {
  await withFile(
    JSON.stringify({ log: { level: 'warn' }, onebotByUin: { '10001': EMPTY_NETWORKS } }),
    async (path) => {
      await saveOneBotConfig(path, '10002', { ...EMPTY_NETWORKS, qzone: false });
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(parsed.log.level, 'warn');
      assert.ok(parsed.onebotByUin['10001']);
      assert.equal(parsed.onebotByUin['10002'].qzone, false);

      // 再读回来要能选中刚保存的账号。
      const loaded = await loadConfigFile(path);
      assert.equal(mergeConfig({ file: loaded, uin: '10002' }).onebot?.qzone, false);
    },
  );
});

test('mergeConfig：没有命令行 qq-db 时用配置文件的值', () => {
  const merged = mergeConfig({
    file: { qq: { dbPath: '/from/file.db' } },
    uin: '10001',
  });
  assert.equal(merged.qq?.dbPath, '/from/file.db');
});

test('mergeConfig：配置文件里出现 account 也压不掉 --account', () => {
  // 类型上不允许，但 JSON 是运行时数据；这里锁住行为。
  const file = { account: { uin: '99999' } } as never;
  assert.equal(mergeConfig({ file, uin: '10001' }).account.uin, '10001');
});
