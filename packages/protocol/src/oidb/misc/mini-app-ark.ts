// LightAppSvc.mini_app_share.AdaptShareInfo — 小程序分享卡片。
//
// 裸 SSO（无 OIDB 信封）：请求 f2=sdkVersion，f4=body；响应 f4.body.f2=jsonStr。
// 只支持 bili / weibo，与 SnowLuma 的参数面一致。

import { decode, encode, message } from '../../protobuf';
import { sendPacket, type TrpcNative } from '../../transport';

export const MINI_APP_SHARE_CMD = 'LightAppSvc.mini_app_share.AdaptShareInfo';

const MINI_APP_BODY = message([
  { name: 'appid', tag: 2, type: 'string' },
  { name: 'title', tag: 3, type: 'string' },
  { name: 'desc', tag: 4, type: 'string' },
  { name: 'picUrl', tag: 9, type: 'string' },
  { name: 'jumpUrl', tag: 11, type: 'string' },
  { name: 'iconUrl', tag: 12, type: 'string' },
]);

const MINI_APP_REQ = message([
  { name: 'sdkVersion', tag: 2, type: 'string' },
  { name: 'body', tag: 4, type: MINI_APP_BODY },
]);

const MINI_APP_RESP_BODY = message([{ name: 'jsonStr', tag: 2, type: 'string' }]);

const MINI_APP_RESP = message([
  { name: 'status', tag: 2, type: 'uint32' },
  { name: 'msg', tag: 3, type: 'string' },
  { name: 'body', tag: 4, type: MINI_APP_RESP_BODY },
]);

export interface MiniAppArkParams {
  type: string;
  title: string;
  desc: string;
  picUrl: string;
  jumpUrl: string;
}

export interface MiniAppArkResult {
  data: {
    ver: unknown;
    prompt: unknown;
    config: unknown;
    app: unknown;
    view: unknown;
    meta: unknown;
    miniappShareOrigin: 3;
    miniappOpenRefer: '10002';
  };
}

const APPS: Record<string, { appid: string; iconUrl: string }> = {
  bili: {
    appid: '1109937557',
    iconUrl: 'http://miniapp.gtimg.cn/public/appicon/51f90239b78a2e4994c11215f4c4ba15_200.jpg',
  },
  weibo: {
    appid: '1109224783',
    iconUrl: 'http://miniapp.gtimg.cn/public/appicon/35bbb44dc68e65194cfacfb206b8f1f7_200.jpg',
  },
};

export namespace GetMiniAppArk {
  export const cmd = MINI_APP_SHARE_CMD;
  export const reqSchema = MINI_APP_REQ;
  export const respSchema = MINI_APP_RESP;

  export const serialize = (p: MiniAppArkParams): Record<string, unknown> => {
    const app = APPS[p.type];
    if (!app) throw new Error(`unsupported type: ${p.type}, only support bili and weibo`);
    return {
      sdkVersion: 'V1_PC_MINISDK_99.99.99_1_APP_A',
      body: {
        appid: app.appid,
        title: p.title,
        desc: p.desc,
        picUrl: p.picUrl,
        jumpUrl: p.jumpUrl,
        iconUrl: app.iconUrl,
      },
    };
  };

  export const deserialize = (body: Record<string, unknown>): MiniAppArkResult => {
    const status = typeof body.status === 'number' ? body.status : 0;
    if (status !== 0) {
      throw new Error(`mini app share failed: ${typeof body.msg === 'string' ? body.msg : status}`);
    }
    const respBody = body.body as Record<string, unknown> | undefined;
    const jsonStr = typeof respBody?.jsonStr === 'string' ? respBody.jsonStr : '';
    if (!jsonStr) throw new Error('mini app share json empty');
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      data: {
        ver: parsed.ver,
        prompt: parsed.prompt,
        config: parsed.config,
        app: parsed.appName,
        view: parsed.appView,
        meta: parsed.metaData,
        miniappShareOrigin: 3,
        miniappOpenRefer: '10002',
      },
    };
  };

  export const invoke = async (
    nt: TrpcNative,
    pid: number,
    params: MiniAppArkParams,
  ): Promise<MiniAppArkResult> => {
    const bytes = await sendPacket(nt, pid, cmd, encode(MINI_APP_REQ, serialize(params)));
    return deserialize(decode(MINI_APP_RESP, bytes));
  };
}
