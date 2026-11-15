/**
 * WebUI HTTP 层（W1/W2）：安全边界 + 鉴权 + 静态资源 / SPA 回退 + 调试 action。
 *
 * 用真 `http` 服务 + 假 `ConsoleRuntime`：验路由与头，不验 QQ 能力。
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebUiAuth } from '../src/webui/auth';
import type { ConsoleRuntime } from '../src/webui/console';
import { Observability } from '../src/webui/observability';
import { createWebUiRouter } from '../src/webui/routes';
import { createWebUiServer, type WebUiServerHandle } from '../src/webui/server';

const TOKEN = 'wqb_AAAAAAAAAAAAAAAAAAAAAAAA';

interface Harness {
  port: number;
  close(): Promise<void>;
}

/** 假运行时：只实现路由真正会碰到的几个方法。 */
function fakeRuntime(state: {
  phase?: string;
  actions?: string[];
  result?: { status: string; retcode: number; data: unknown };
  calls?: Array<{ name: string; params: unknown }>;
}): ConsoleRuntime {
  const actions = state.actions ?? ['get_login_info', 'send_group_msg'];
  const adapter = {
    actions: () => actions,
    skipped: () => [],
    describe: () =>
      actions.map((name) => ({
        name,
        summary: `summary:${name}`,
        description: '',
        inputSchema: {},
        group: name.startsWith('send_') ? 'message' : 'contact',
        write: name.startsWith('send_'),
      })),
    networks: () => [],
    call: async (name: string, params: unknown) => {
      state.calls?.push({ name, params });
      return state.result ?? { status: 'ok', retcode: 0, data: { ok: true } };
    },
    port: undefined,
    start: async () => {},
    stop: async () => {},
  };
  const reloaded: unknown[] = [];
  return {
    reloaded,
    currentPhase: (state.phase ?? 'online') as never,
    currentBot: {
      onebot: adapter,
      reloadOneBot: async (config: unknown) => {
        reloaded.push(config);
      },
    } as never,
    accounts: async () => [],
    environment: async () => ({
      platform: process.platform,
      qqExe: null,
      installRoot: null,
      wrapperNode: null,
      majorNode: null,
      dataRoot: null,
      loginDbs: [],
    }),
    startAccount: async () => {},
    startQrLogin: async () => ({ state: 'waiting-scan', expiresAt: Date.now() + 45_000 }),
    cancelQrLogin: () => {},
    overview: () => ({
      phase: 'online',
      messages: { received: 0, sent: 0 },
      heartbeat: { samples: [] },
      networks: [],
      actions: { registered: actions.length, skipped: 0 },
    }),
    logout: async () => {},
    consoleEvents: { on: () => () => {} },
    close: async () => {},
  } as unknown as ConsoleRuntime;
}

async function start(
  options: {
    staticDir?: string;
    actions?: string[];
    result?: { status: string; retcode: number; data: unknown };
  } = {},
): Promise<Harness> {
  const auth = new WebUiAuth(TOKEN);
  const observability = new Observability();
  const runtime = fakeRuntime({
    ...(options.actions ? { actions: options.actions } : {}),
    ...(options.result ? { result: options.result } : {}),
  });
  const router = createWebUiRouter({
    auth,
    console: runtime,
    observability,
    readConfig: () => undefined,
  });
  const server = createWebUiServer({
    port: 0,
    ...(options.staticDir ? { staticDir: options.staticDir } : {}),
    handle: (input) => router.handle(input),
  });
  const handle: WebUiServerHandle = await server.start();
  return { port: handle.port, close: () => handle.close() };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: init.method ?? 'GET',
        headers: { host: `127.0.0.1:${port}`, ...init.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

async function login(port: number): Promise<string> {
  const reply = await call(port, '/api/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  assert.equal(reply.status, 204);
  const cookie = reply.headers['set-cookie'];
  assert.ok(Array.isArray(cookie));
  return cookie[0]!.split(';')[0]!;
}

// ─────────────────────────── 安全头与 Host 校验 ───────────────────────────

test('所有响应都带 CSP / nosniff / no-referrer', async () => {
  const harness = await start();
  try {
    const reply = await call(harness.port, '/api/auth/session');
    const csp = String(reply.headers['content-security-policy']);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(reply.headers['x-content-type-options'], 'nosniff');
    assert.equal(reply.headers['referrer-policy'], 'no-referrer');
  } finally {
    await harness.close();
  }
});

test('Host 不是回环时 421（防 DNS rebinding）', async () => {
  const harness = await start();
  try {
    const reply = await call(harness.port, '/api/auth/session', {
      headers: { host: 'evil.example.com' },
    });
    assert.equal(reply.status, 421);
    assert.equal(JSON.parse(reply.body).code, 'HOST_REJECTED');
  } finally {
    await harness.close();
  }
});

test('localhost 与 127.0.0.1 都接受；端口不对拒绝', async () => {
  const harness = await start();
  try {
    const viaLocalhost = await call(harness.port, '/api/auth/session', {
      headers: { host: `localhost:${harness.port}` },
    });
    assert.equal(viaLocalhost.status, 200);

    const wrongPort = await call(harness.port, '/api/auth/session', {
      headers: { host: '127.0.0.1:1' },
    });
    assert.equal(wrongPort.status, 421);
  } finally {
    await harness.close();
  }
});

test('写请求的 Origin 必须同源', async () => {
  const harness = await start();
  try {
    const cookie = await login(harness.port);
    const crossSite = await call(harness.port, '/api/account/logout', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(crossSite.status, 403);

    const sameSite = await call(harness.port, '/api/account/logout', {
      method: 'POST',
      headers: {
        cookie,
        origin: `http://127.0.0.1:${harness.port}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(sameSite.status, 200);
  } finally {
    await harness.close();
  }
});

// ─────────────────────────── 鉴权 ───────────────────────────

test('令牌格式不对 400；错误令牌 401 带剩余次数；正确令牌 204 + cookie', async () => {
  const harness = await start();
  try {
    const malformed = await call(harness.port, '/api/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'nope' }),
    });
    assert.equal(malformed.status, 400);

    const wrong = await call(harness.port, '/api/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wqb_BBBBBBBBBBBBBBBBBBBBBBBB' }),
    });
    assert.equal(wrong.status, 401);
    assert.equal(JSON.parse(wrong.body).remainingAttempts, 4);

    const cookie = await login(harness.port);
    assert.match(cookie, /^wqb_session=[0-9a-f]{64}$/);
  } finally {
    await harness.close();
  }
});

test('未登录访问业务接口 401；登录后可访问', async () => {
  const harness = await start();
  try {
    const anonymous = await call(harness.port, '/api/overview');
    assert.equal(anonymous.status, 401);

    const cookie = await login(harness.port);
    const authed = await call(harness.port, '/api/overview', { headers: { cookie } });
    assert.equal(authed.status, 200);
    assert.equal(JSON.parse(authed.body).phase, 'online');
  } finally {
    await harness.close();
  }
});

test('DELETE /api/auth/session 清 cookie，账号不下线', async () => {
  const harness = await start();
  try {
    const cookie = await login(harness.port);
    const out = await call(harness.port, '/api/auth/session', {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.equal(out.status, 204);
    const cookieHeader = String(out.headers['set-cookie']);
    assert.match(cookieHeader, /Max-Age=0/);

    const after = await call(harness.port, '/api/overview', { headers: { cookie } });
    assert.equal(after.status, 401);
  } finally {
    await harness.close();
  }
});

// ─────────────────────────── 静态资源 / SPA ───────────────────────────

async function staticDirFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'weqbot-webui-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>console</title>');
  await writeFile(join(dir, 'app.js'), 'console.log(1)');
  return dir;
}

test('静态资源按扩展名给 content-type；未知路径回退 index.html', async () => {
  const dir = await staticDirFixture();
  const harness = await start({ staticDir: dir });
  try {
    const js = await call(harness.port, '/app.js');
    assert.equal(js.status, 200);
    assert.match(String(js.headers['content-type']), /javascript/);

    const spa = await call(harness.port, '/some/deep/route');
    assert.equal(spa.status, 200);
    assert.match(String(spa.headers['content-type']), /text\/html/);
    assert.match(spa.body, /console/);

    // 带扩展名的缺失文件必须 404，不能回 HTML（否则浏览器报 MIME 错）。
    const missing = await call(harness.port, '/missing.js');
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});

test('路径穿越被拒（../ 不能读到 dist 之外）', async () => {
  const dir = await staticDirFixture();
  const harness = await start({ staticDir: dir });
  try {
    const traversal = await call(harness.port, '/../package.json');
    assert.equal(traversal.status, 404);
    const encoded = await call(harness.port, '/%2e%2e%2fpackage.json');
    assert.equal(encoded.status, 404);
  } finally {
    await harness.close();
  }
});

// ─────────────────────────── 调试 action ───────────────────────────

test('GET /api/actions 列出 group / write；POST 执行并把结果回给前端', async () => {
  const harness = await start();
  try {
    const cookie = await login(harness.port);

    const list = await call(harness.port, '/api/actions', { headers: { cookie } });
    assert.equal(list.status, 200);
    const actions = JSON.parse(list.body).actions as Array<{
      name: string;
      group: string;
      write: boolean;
    }>;
    assert.equal(actions.length, 2);
    assert.deepEqual(
      actions.find((item) => item.name === 'send_group_msg'),
      { name: 'send_group_msg', summary: 'summary:send_group_msg', group: 'message', write: true },
    );

    const run = await call(harness.port, '/api/actions/get_login_info', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ params: { user_id: 1 } }),
    });
    assert.equal(run.status, 200);
    assert.equal(JSON.parse(run.body).status, 'ok');
    assert.ok(JSON.parse(run.body).latencyMs >= 0);
  } finally {
    await harness.close();
  }
});

test('未知 action 404；没有 OneBot 适配器时 409', async () => {
  const harness = await start({ actions: ['get_login_info'] });
  try {
    const cookie = await login(harness.port);
    const unknown = await call(harness.port, '/api/actions/nope', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(unknown.status, 404);
  } finally {
    await harness.close();
  }
});

// ─────────────────────────── 网络配置 ───────────────────────────

test('PUT /api/onebot/config：accessToken 打码值不会被写回成字面量', async () => {
  const harness = await start();
  try {
    const cookie = await login(harness.port);
    const reply = await call(harness.port, '/api/onebot/config', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          networks: {
            httpServers: [
              {
                name: 'main',
                port: 6700,
                accessToken: '***',
                messageFormat: 'array',
                reportSelfMessage: true,
              },
            ],
            httpClients: [],
            wsServers: [],
            wsClients: [],
          },
        },
      }),
    });
    // 没有 bot 时 reloadOneBot 不会执行，配置仍然会被接受并保存（无 configPath 时只校验）。
    assert.equal(reply.status, 200);
    const saved = JSON.parse(reply.body).config;
    assert.equal(saved.networks.httpServers[0].accessToken, undefined);
  } finally {
    await harness.close();
  }
});

test('PUT /api/onebot/config：端口冲突被拒', async () => {
  const harness = await start();
  try {
    const cookie = await login(harness.port);
    const reply = await call(harness.port, '/api/onebot/config', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          networks: {
            httpServers: [
              { name: 'a', port: 6700, messageFormat: 'array', reportSelfMessage: true },
            ],
            wsServers: [{ name: 'b', port: 6700, messageFormat: 'array', reportSelfMessage: true }],
            httpClients: [],
            wsClients: [],
          },
        },
      }),
    });
    assert.equal(reply.status, 400);
    assert.equal(JSON.parse(reply.body).code, 'PORT_CONFLICT');
  } finally {
    await harness.close();
  }
});
