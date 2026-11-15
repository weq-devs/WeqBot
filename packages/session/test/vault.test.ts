import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileCredentialVault, type SecretStore } from '../src/vault';

const account = {
  uin: '2863253201',
  uid: 'u_test',
  a1: new Uint8Array([1, 2, 3, 4, 5]),
  guid: '0123456789abcdef0123456789abcdef',
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

    const mode = (await stat(join(dir, `${account.uin}.json`))).mode & 0o777;
    assert.equal(mode, 0o600);

    const loaded = await vault.get(account.uin);
    assert.ok(loaded);
    assert.deepEqual([...loaded.a1], [...account.a1]);
    assert.equal(loaded.guid, account.guid);
    assert.deepEqual(loaded.device, account.device);
    assert.equal(await vault.get('123456'), undefined);

    assert.deepEqual(await vault.list(), [{ uin: account.uin, uid: account.uid }]);
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
    assert.ok(store.has(`weqbot:${account.uin}`));
    const raw = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(dir, `${account.uin}.json`), 'utf8'),
    );
    assert.ok(!raw.includes('AQIDBAU='));
    assert.ok(raw.includes('a1Ref'));

    const loaded = await vault.get(account.uin);
    assert.deepEqual([...loaded!.a1], [...account.a1]);
    await vault.delete(account.uin);
    assert.equal(store.has(`weqbot:${account.uin}`), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
