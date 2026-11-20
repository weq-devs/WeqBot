import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileCredentialVault, type SecretStore } from '../src/vault';

const account = {
  uin: '10002',
  uid: 'u_test',
  a1: new Uint8Array([1, 2, 3, 4, 5]),
  guid: '0123456789abcdef0123456789abcdef',
  group: 'self' as const,
  device: {
    os: 'linux' as const,
    appId: 1600001615,
    subAppId: 537403759,
    qua: 'V1_LINUX_9.9.9',
    clientVersion: '9.9.9-1',
  },
};

test('文件 vault：写读删 + 0600 权限', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weqbot-vault-'));
  try {
    const vault = new FileCredentialVault({ dir });
    await vault.put(account);

    // 文件名带组前缀：同一个 uin 在两组的凭据不能互相覆盖。
    const mode = (await stat(join(dir, `self-${account.uin}.json`))).mode & 0o777;
    assert.equal(mode, 0o600);

    const loaded = await vault.get(account.uin);
    assert.ok(loaded);
    assert.deepEqual([...loaded.a1], [...account.a1]);
    assert.equal(loaded.guid, account.guid);
    assert.equal(loaded.group, 'self');
    assert.deepEqual(loaded.device, account.device);
    assert.equal(await vault.get('123456'), undefined);

    assert.deepEqual(await vault.list(), [{ uin: account.uin, uid: account.uid, group: 'self' }]);
    await vault.delete(account.uin);
    assert.equal(await vault.get(account.uin), undefined);
    assert.deepEqual(await vault.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件 vault：注入 SecretStore 后 a1 不落 JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weqbot-vault-'));
  const store = new Map<string, string>();
  const secrets: SecretStore = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
  };
  try {
    const vault = new FileCredentialVault({ dir, secrets });
    await vault.put(account);
    assert.ok(store.has(`weqbot:self:${account.uin}`), 'keychain 的键必须带组');
    const raw = await readFile(join(dir, `self-${account.uin}.json`), 'utf8');
    assert.ok(!raw.includes('AQIDBAU='));
    assert.ok(raw.includes('a1Ref'));

    const loaded = await vault.get(account.uin);
    assert.deepEqual([...loaded!.a1], [...account.a1]);
    await vault.delete(account.uin);
    assert.equal(store.has(`weqbot:self:${account.uin}`), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件 vault：同一 uin 的本机 / 自主凭据互不覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weqbot-vault-'));
  try {
    const vault = new FileCredentialVault({ dir });
    const local = {
      ...account,
      group: 'local' as const,
      guid: 'f'.repeat(32),
      a1: new Uint8Array([7, 7, 7]),
    };
    await vault.put(local);
    await vault.put(account);

    const readLocal = await vault.get(account.uin, 'local');
    const readSelf = await vault.get(account.uin, 'self');
    assert.equal(readLocal?.guid, 'f'.repeat(32));
    assert.equal(readSelf?.guid, account.guid);
    assert.deepEqual([...readLocal!.a1], [7, 7, 7]);
    assert.deepEqual([...readSelf!.a1], [...account.a1]);

    assert.deepEqual(
      (await vault.list()).map((item) => item.group),
      ['local', 'self'],
    );

    // 只删一组：另一组的设备身份必须原样保留。
    await vault.delete(account.uin, 'local');
    assert.equal(await vault.get(account.uin, 'local'), undefined);
    assert.equal((await vault.get(account.uin, 'self'))?.guid, account.guid);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件 vault：旧版单文件按 a1Origin 推断分组', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weqbot-vault-'));
  try {
    // 旧布局：`<uin>.json`，没有 group 字段。
    const legacy = {
      version: 1,
      account: {
        ...account,
        group: undefined,
        a1Origin: 'login-db' as const,
        a1: Buffer.from(account.a1).toString('base64'),
      },
    };
    await writeFile(join(dir, `${account.uin}.json`), JSON.stringify(legacy), { mode: 0o600 });

    const vault = new FileCredentialVault({ dir });
    const readLocal = await vault.get(account.uin, 'local');
    assert.ok(readLocal, 'login.db 来的旧凭据要归到本机组');
    assert.equal(readLocal.group, 'local');
    // 组不对时当作不存在 —— 拿本机凭据去当自主账号用正是分组要禁止的事。
    assert.equal(await vault.get(account.uin, 'self'), undefined);

    // 再写一次就落到新布局，旧文件不再被读到。
    await vault.put(readLocal);
    await assert.rejects(stat(join(dir, `${account.uin}.json`)), { code: 'ENOENT' });
    assert.deepEqual(await vault.list('local'), [
      { uin: account.uin, uid: account.uid, group: 'local' },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
