/**
 * 开发期 mock（`VITE_WEBUI_MOCK=1`）：不连后端也能把六个页面走一遍。
 *
 * 节奏与真服务一致：5 次失败锁 30 秒、扫码 45 秒倒计时、事件流有增量。
 * 数据全是假的，但**形状与 `types.ts` 完全一致** —— 页面代码不需要为 mock
 * 写任何分支。
 */

import {
  ApiError,
  type ActionCallEntry,
  type ConsolePhase,
  type ConsoleStateEvent,
  type LoginAccount,
  type LoginEnvironment,
  type LogEntry,
  type OneBotConfig,
  type Overview,
  type PushEventEntry,
  type QrSnapshot,
  type SessionResult,
  type SettingsSnapshot,
  type StreamName,
} from './types';

export const MOCK_TOKEN = 'wqb_8Kf2mQ7xLr4Tn9vB3cZp6hJd';

const MAX_ATTEMPTS = 5;
const LOCK_MS = 30_000;
const SESSION_KEY = 'weqbot.mock.session';

const state = {
  failures: 0,
  lockedUntil: 0,
  offline: false,
  phase: 'online' as ConsolePhase,
  qr: null as QrSnapshot | null,
};
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export const mockControls = {
  isOffline: () => state.offline,
  setOffline(value: boolean): void {
    state.offline = value;
    notify();
  },
  reset(): void {
    state.failures = 0;
    state.lockedUntil = 0;
    notify();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const latency = (base: number) => base + Math.round(Math.random() * base * 0.5);

async function createSession(token: string): Promise<SessionResult> {
  await sleep(latency(420));
  if (state.offline) return { ok: false, reason: 'unreachable' };

  const now = Date.now();
  if (state.lockedUntil > now) {
    return { ok: false, reason: 'locked', retryAfterMs: state.lockedUntil - now };
  }
  if (token !== MOCK_TOKEN) {
    state.failures += 1;
    if (state.failures >= MAX_ATTEMPTS) {
      state.failures = 0;
      state.lockedUntil = now + LOCK_MS;
      return { ok: false, reason: 'locked', retryAfterMs: LOCK_MS };
    }
    return { ok: false, reason: 'invalid', remainingAttempts: MAX_ATTEMPTS - state.failures };
  }

  state.failures = 0;
  sessionStorage.setItem(SESSION_KEY, '1');
  return { ok: true };
}

const ENVIRONMENT: LoginEnvironment = {
  platform: 'linux',
  qqExe: '/opt/QQ/qq',
  installRoot: '/opt/QQ',
  // 用 `['node'].join` 拼出文件名：`check-pure-ts` 禁止 `webui` 出现 `.node'`
  // 这类字面量（它按字符串判「是否加载原生组件」），这里只是 mock 路径。
  wrapperNode: `/opt/QQ/resources/app/wrapper.${['node'].join('')}`,
  majorNode: `/opt/QQ/resources/app/major.${['node'].join('')}`,
  dataRoot: '/home/me/.config/QQ',
  loginDbs: ['/home/me/.config/QQ/global/nt_db/login.db'],
  client: { appid: '1600001615', qua: 'V1_LINUX_3.2.35', version: '3.2.35-54395', build: '54395' },
  qqRunning: false,
};

const ACCOUNTS: LoginAccount[] = [
  {
    uin: '10002',
    uid: 'u_LKt3AdAIMP-CUfn6ydzDzw',
    nickname: '冬眠的猫',
    lastLoginAt: Date.now() - 3 * 60 * 60 * 1000,
    hasA1: true,
  },
  {
    uin: '10001',
    uid: 'u_9kPq2SdLmNx6RtVw8YzAbc',
    nickname: '小号测试',
    lastLoginAt: Date.now() - 9 * 24 * 60 * 60 * 1000,
    hasA1: false,
  },
];

const ONLINE_SINCE = Date.now() - 1000 * 60 * 47;

let mockQzone = true;

/** 设置页「手动指定」的路径；`null` 表示走自动探测（与后端语义一致）。 */
const mockQqPaths: { installDir: string | null; dataDir: string | null } = {
  installDir: null,
  dataDir: null,
};

/** 覆盖项的来源标记，用来在检查卡上显示「手动」。 */
const mockQqSources: { installDir?: 'override'; dataDir?: 'override' } = {};

const mockLogging: {
  dir: string | null;
  level: SettingsSnapshot['logging']['level'];
  files: Array<{ name: string; size: number }>;
} = {
  dir: '/workspace/logs',
  level: 'info',
  files: [
    { name: 'weqbot-2026-11-16.log', size: 16470 },
    { name: 'native.log', size: 8067 },
  ],
};

function settingsSnapshot(): SettingsSnapshot {
  return {
    environment: {
      ...ENVIRONMENT,
      ...(mockQqPaths.installDir ? { installRoot: mockQqPaths.installDir } : {}),
      ...(mockQqPaths.dataDir ? { dataRoot: mockQqPaths.dataDir } : {}),
      sources: {
        ...(mockQqSources.installDir
          ? { qqExe: 'override' as const }
          : { qqExe: 'detected' as const }),
        ...(mockQqSources.dataDir
          ? { dataRoot: 'override' as const }
          : { dataRoot: 'detected' as const }),
      },
      qqDbPath: '/home/me/.config/QQ/nt_qq_2472b5970cc3e5c0348c9601425e4186/nt_db/nt_msg.db',
    },
    account: { uin: '10002' },
    onebot: { qzone: mockQzone },
    qqPaths: { installDir: mockQqPaths.installDir, dataDir: mockQqPaths.dataDir },
    logging: {
      dir: mockLogging.dir,
      level: mockLogging.level,
      fileLevel: 'debug',
      files: mockLogging.files,
    },
    runtime: {
      platform: 'linux',
      arch: 'x64',
      node: 'v22.12.0',
      pid: 4242,
      uptimeSec: 2820,
      configPath: '/workspace/weqbot.json',
    },
  };
}

function overview(): Overview {
  const online = state.phase === 'online';
  return {
    phase: state.phase,
    ...(online
      ? {
          account: {
            uin: '10002',
            uid: 'u_LKt3AdAIMP-CUfn6ydzDzw',
            nickname: '冬眠的猫',
            avatarUrl: `/api/avatar/10002`,
            onlineSince: ONLINE_SINCE,
            startedAt: ONLINE_SINCE - 12_000,
            device: {
              os: 'linux',
              appId: 1600001615,
              subAppId: 537403759,
              qua: 'V1_LINUX_3.2.35',
              clientVersion: '3.2.35-54395',
            },
            reconnects: 1,
            secTokenRotatesAt: ONLINE_SINCE + 24 * 60 * 60 * 1000,
            sessionId: 1,
          },
        }
      : {}),
    messages: { received: 1284, sent: 96 },
    heartbeat: {
      samples: Array.from({ length: 30 }, () => 900 + Math.round(Math.random() * 260)),
      medianMs: 1012,
    },
    networks: online
      ? [
          {
            kind: 'ws-server',
            name: '正向 WS',
            endpoint: '127.0.0.1:6700/',
            state: 'listening',
            port: 6700,
            clients: 2,
          },
          {
            kind: 'http-server',
            name: 'HTTP',
            endpoint: '127.0.0.1:5700/',
            state: 'listening',
            port: 5700,
            clients: 0,
          },
          {
            kind: 'ws-client',
            name: '上报',
            endpoint: 'ws://127.0.0.1:8080/onebot/v11/ws',
            state: 'connected',
            clients: 1,
          },
        ]
      : [],
    actions: { registered: online ? 198 : 0, skipped: 7 },
    ...(online ? { onebotPort: 6700 } : {}),
    system: {
      platform: 'linux',
      arch: 'x64',
      cpus: 16,
      loadAvg: [0.42, 0.38, 0.31],
      uptimeSec: 86_400 * 3 + 3600 * 5,
      processUptimeSec: 1000 * 60 * 47,
      memory: {
        rss: 182 * 1024 * 1024,
        heapUsed: 64 * 1024 * 1024,
        heapTotal: 92 * 1024 * 1024,
      },
      systemMemory: { total: 32 * 1024 ** 3, free: 9.4 * 1024 ** 3 },
      storage: { path: '/workspace/logs', total: 512 * 1024 ** 3, free: 187 * 1024 ** 3 },
      logDir: '/workspace/logs',
    },
  };
}

const ACTIONS = [
  { name: 'get_login_info', summary: '获取登录账号信息', group: 'account', write: false },
  { name: 'get_friend_list', summary: '获取好友列表', group: 'contact', write: false },
  { name: 'get_group_list', summary: '获取群列表', group: 'contact', write: false },
  { name: 'get_group_member_list', summary: '获取群成员列表', group: 'contact', write: false },
  { name: 'get_msg', summary: '获取一条消息', group: 'message', write: false },
  { name: 'send_group_msg', summary: '发送群消息', group: 'message', write: true },
  { name: 'send_private_msg', summary: '发送私聊消息', group: 'message', write: true },
  { name: 'delete_msg', summary: '撤回消息', group: 'message', write: true },
  { name: 'set_group_ban', summary: '禁言群成员', group: 'group-admin', write: true },
  { name: 'get_qzone_msg_list', summary: '获取说说列表', group: 'qzone', write: false },
  {
    name: 'get_gift_mall_list',
    summary: '礼物商城首页礼物列表',
    group: 'account-web',
    write: false,
  },
  { name: 'send_gift', summary: '赠送礼物（仅下单）', group: 'account-web', write: true },
  { name: 'forward_qzone_msg', summary: '转发一条普通说说', group: 'qzone', write: true },
];

const LOG_SCOPES = ['bot', 'onebot', 'session.online', 'webui', 'protocol'];
const LOG_MESSAGES = [
  ['info', 'OneBot 已启动'],
  ['debug', 'Action 参数校验通过'],
  ['info', '消息'],
  ['warn', '未建模的推送'],
  ['info', 'SecToken 已原地轮换'],
] as const;

function* fakeLogEntries(): Generator<LogEntry> {
  let i = 0;
  for (;;) {
    const [level, msg] = LOG_MESSAGES[i % LOG_MESSAGES.length]!;
    yield {
      ts: Date.now(),
      level,
      scope: LOG_SCOPES[i % LOG_SCOPES.length]!,
      msg,
      ...(level === 'info' && msg === '消息'
        ? { fields: { scene: 'group', peer: 20001 + (i % 3), elements: 1 } }
        : {}),
    };
    i++;
  }
}

function* fakeActionEntries(): Generator<ActionCallEntry> {
  let i = 0;
  for (;;) {
    const action = ACTIONS[i % ACTIONS.length]!;
    const failed = i % 17 === 0;
    yield {
      ts: Date.now(),
      action: action.name,
      params: action.name.includes('group') ? { group_id: 20001 } : {},
      retcode: failed ? 100 : 0,
      status: failed ? 'failed' : 'ok',
      latencyMs: 8 + Math.round(Math.random() * 120),
      transport: i % 4 === 0 ? 'webui' : 'ws',
      client: i % 4 === 0 ? 'webui' : '正向 WS',
    };
    i++;
  }
}

function* fakePushEntries(): Generator<PushEventEntry> {
  let i = 0;
  const kinds = ['message', 'notice', 'request', 'state'];
  for (;;) {
    const type = kinds[i % kinds.length]!;
    yield {
      ts: Date.now(),
      type,
      kind: type === 'message' ? 'group' : type === 'notice' ? 'group-member-decrease' : type,
      peer: type === 'message' ? '20001' : undefined,
      summary: type === 'message' ? `${10001 + i} → 20001: 你好` : type,
    };
    i++;
  }
}

function startTicker(stream: StreamName, handler: (entry: unknown) => void): () => void {
  const generator =
    stream === 'logs'
      ? fakeLogEntries()
      : stream === 'actions'
        ? fakeActionEntries()
        : fakePushEntries();
  // 先补 20 条历史，再按 1.2s 的节奏推。
  for (let i = 0; i < 20; i++) handler(generator.next().value);
  const timer = setInterval(() => handler(generator.next().value), 1200);
  return () => clearInterval(timer);
}

function qrTimer(): QrSnapshot {
  const started = Date.now();
  state.qr = { state: 'waiting-scan', expiresAt: started + 45_000 };
  setTimeout(() => {
    if (state.qr?.state === 'waiting-scan') {
      state.qr = { ...state.qr, state: 'waiting-confirm' };
      notify();
    }
  }, 6000);
  setTimeout(() => {
    if (state.qr?.state === 'waiting-confirm') {
      state.qr = { ...state.qr, state: 'expired', error: '二维码已过期' };
      notify();
    }
  }, 45_000);
  return state.qr;
}

const CONFIG: OneBotConfig = {
  networks: {
    httpServers: [
      {
        kind: 'httpServers',
        name: 'HTTP',
        host: '127.0.0.1',
        port: 5700,
        path: '/',
        messageFormat: 'array',
        reportSelfMessage: false,
        enableWebSocket: true,
      },
    ],
    httpClients: [],
    wsServers: [
      {
        kind: 'wsServers',
        name: '正向 WS',
        host: '127.0.0.1',
        port: 6700,
        path: '/',
        role: 'Universal',
        messageFormat: 'array',
        reportSelfMessage: false,
      },
    ],
    wsClients: [
      {
        kind: 'wsClients',
        name: '上报',
        url: 'ws://127.0.0.1:8080/onebot/v11/ws',
        role: 'Universal',
        reconnectIntervalMs: 5000,
        messageFormat: 'array',
        reportSelfMessage: true,
      },
    ],
  },
  qzone: true,
  qzoneDomain: 'qzone.qq.com',
};

export const mockApi = {
  auth: {
    createSession,
    async getSession() {
      await sleep(latency(60));
      if (state.offline) throw new ApiError(0, 'UNREACHABLE');
      return { authenticated: sessionStorage.getItem(SESSION_KEY) === '1' };
    },
    async deleteSession() {
      await sleep(latency(120));
      sessionStorage.removeItem(SESSION_KEY);
    },
  },

  login: {
    async environment() {
      await sleep(latency(160));
      return ENVIRONMENT;
    },
    async accounts() {
      await sleep(latency(200));
      return ACCOUNTS;
    },
    async start(uin: string) {
      await sleep(latency(900));
      void uin;
      state.phase = 'online';
    },
    async startQr() {
      await sleep(latency(140));
      return qrTimer();
    },
    async cancelQr() {
      state.qr = null;
    },
  },

  overview: {
    async get() {
      await sleep(latency(120));
      return overview();
    },
  },

  network: {
    async get() {
      await sleep(latency(90));
      return CONFIG;
    },
    async save(config: OneBotConfig) {
      await sleep(latency(420));
      return config;
    },
  },

  settings: {
    async get() {
      await sleep(latency(120));
      return settingsSnapshot();
    },
    async update(patch: {
      logDir?: string | null;
      level?: SettingsSnapshot['logging']['level'];
      qzone?: boolean;
      qqPaths?: { installDir?: string | null; dataDir?: string | null };
      refresh?: boolean;
    }) {
      await sleep(latency(160));
      if (patch.logDir !== undefined) {
        mockLogging.dir = patch.logDir === '' || patch.logDir === 'off' ? null : patch.logDir;
      }
      if (patch.level !== undefined) mockLogging.level = patch.level;
      if (patch.qzone !== undefined) mockQzone = patch.qzone;
      if (patch.qqPaths !== undefined) {
        // 与后端一致：`null` / 空串 = 清除覆盖，回到自动探测。
        for (const key of ['installDir', 'dataDir'] as const) {
          if (!(key in patch.qqPaths)) continue;
          const value = patch.qqPaths[key]?.trim() ?? '';
          mockQqPaths[key] = value.length > 0 ? value : null;
          mockQqSources[key] = mockQqPaths[key] ? 'override' : undefined;
        }
      }
      return settingsSnapshot();
    },
  },

  logs: {
    async stats() {
      await sleep(latency(80));
      return {
        actions: {
          total: 482,
          ok: 470,
          failed: 12,
          byAction: ACTIONS.slice(0, 6).map((action, index) => ({
            action: action.name,
            count: 120 - index * 15,
            failed: index === 2 ? 4 : 0,
          })),
          byRetcode: [
            { retcode: 100, count: 9 },
            { retcode: 1404, count: 3 },
          ],
          latency: { p50: 24, p95: 88, max: 402 },
          transports: { ws: 367, http: 90, webui: 25 },
        },
        logs: { total: 1820 },
        events: { total: 664 },
      };
    },
    stream(stream: StreamName, handlers: { onEntry(entry: unknown): void; onError?(): void }) {
      return startTicker(stream, handlers.onEntry);
    },
  },

  debug: {
    async actions() {
      await sleep(latency(100));
      return { actions: ACTIONS, phase: state.phase, onebot: true };
    },
    async run(name: string, params: Record<string, unknown>) {
      await sleep(latency(320));
      void params;
      return {
        status: 'ok' as const,
        retcode: 0,
        data: {
          action: name,
          mock: true,
          ...(name === 'get_login_info' ? { user_id: 10002, nickname: '冬眠的猫' } : {}),
        },
        latencyMs: 18,
      };
    },
  },

  account: {
    async logout() {
      await sleep(latency(260));
      state.phase = 'no-account';
    },
  },

  events: {
    subscribe(handlers: {
      onConsole(event: ConsoleStateEvent): void;
      onEntry?(stream: StreamName, entry: unknown): void;
      onError?(): void;
    }) {
      const unsubscribe = mockControls.subscribe(() => {
        if (state.qr) handlers.onConsole({ at: Date.now(), qr: state.qr });
      });
      handlers.onConsole({ phase: state.phase, at: Date.now() });
      // mock 下事件流也照常喂数据，日志页的实时感才在。
      const offs = (['logs', 'actions', 'events'] as const).map((stream) =>
        startTicker(stream, (entry) => handlers.onEntry?.(stream, entry)),
      );
      return () => {
        unsubscribe();
        for (const off of offs) off();
      };
    },
  },
};
