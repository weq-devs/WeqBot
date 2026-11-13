/**
 * 签名策略：**以 wire 命令为键的中央表**。
 *
 * ## 为什么是一张表
 *
 * QQ 的签名集合按平台不同，而且三端互不相同（macOS 既不是 Linux 的子集，也
 * 不完全等于 Windows）。WeQ 借的是同机 QQ 的凭据，所以在哪个平台就按哪个平台
 * 的 QQ 行为发 —— **不能取并集**：多带不必要的 `SecInfo` 曾经触发风控。
 *
 * 早期把 `needSign` 写在每个 spec 里、由调用点自己判断平台，结果是：
 *   - 同一个命令在多个 spec 里重复声明（`0xfe1_2` 三处、`0x112a_2` 三处）；
 *   - 动态命令（highway 上传申请）只能手写 `if (oidbCmd === 0x11c4 || …)`；
 *   - 新增/调整一条命令要在几十个文件里找落点。
 *
 * 改成一张按键索引的表后，策略跟着**命令**走而不是跟着调用点走：调用点只管
 * 发包，`transport.ts` 查表得出 `(needSign, mode)`。键就是线上和抓包里看到的
 * 那个字符串，和 `scripts/probe-sign.ts` 的观测结果可以逐条比对。
 *
 * ## 声明方式
 *
 * - `sign: 'all'`              三端都签
 * - `sign: 'none'`             显式登记不签名，不触发未登记警告
 * - `sign: 'non-linux'`        Linux 不签，Windows / macOS 签
 * - `sign: 'not-darwin'`       macOS 不签，Linux / Windows 签
 * - `sign: { linux, win32, darwin }` 三端逐端声明，禁止回落
 * - `mode2: true`              该命令用完整签名（VM mode = 2，见 issue #126）
 *
 * 实测记录见 `docs/develop/sign-policy-20261109.md`。
 */

/** 签名器 VM mode。Linux 的 VM ABI 没有这个参数，固定按 3 处理。 */
export type SignMode = 2 | 3;

/** 三端逐端声明。三个字段都必填 —— 早期让 `darwin` 回落到 `win32` 是错的。 */
export interface PerPlatform {
  linux: boolean;
  win32: boolean;
  darwin: boolean;
}

/** 表的简写形式。 */
export type SignRuleSwitch = 'all' | 'none' | 'non-linux' | 'not-darwin';

export interface SignRule {
  /** 是否带 `SecInfo`（SSO reserved tag 24）。 */
  sign: SignRuleSwitch | PerPlatform;
  /**
   * 用完整签名（VM mode = 2），缺省为精简签名（mode = 3）。
   *
   * 只在 macOS / Windows 生效；Linux 的 VM ABI 没有 mode 参数。
   * 分组依据见 issue #126 的 macOS 实测（`sign=92/96` 那 13 条交集）。
   * ⚠️ 该分组是按签名字节数推断的，服务端是否强制要求完整签名尚未逐条验证。
   */
  mode2?: boolean;
}

/** 解析后的结果，就是要传给 native 的两个值。 */
export interface ResolvedSign {
  needSign: boolean;
  mode: SignMode;
}

/**
 * 按 wire 命令登记的签名策略。
 *
 * 不签名的命令可用 `sign: 'none'` 显式登记，避免与未知命令混淆。
 * 查不到仍按 `{ needSign: false, mode: 3 }` 处理，并保留一次未登记警告。
 */
export const SIGN_RULES = {
  // ─── 三端都签 ───────────────────────────────────────────────────────
  'MessageSvc.PbSendMsg': { sign: 'all', mode2: true },
  'OidbSvcTrpcTcp.0x102a_0': { sign: 'all' },
  'OidbSvcTrpcTcp.0x102a_1': { sign: 'all' },
  'OidbSvcTrpcTcp.0x10c8_1': { sign: 'all', mode2: true },
  'OidbSvcTrpcTcp.0x10c8_2': { sign: 'all', mode2: true },
  'OidbSvcTrpcTcp.0x112a_2': { sign: 'all', mode2: true },
  'OidbSvcTrpcTcp.0x112e_1': { sign: 'all', mode2: true },
  'OidbSvcTrpcTcp.0x11ec_1': { sign: 'all', mode2: true },
  'OidbSvcTrpcTcp.0x6d9_4': { sign: 'all', mode2: true },
  'OidbSvcTrpcTcp.0x89a_0': { sign: 'all' },
  'OidbSvcTrpcTcp.0x89a_15': { sign: 'all', mode2: true },
  'OidbSvcTrpcTcp.0x93d7_1': { sign: 'all', mode2: true },
  'trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg': { sign: 'all' },
  'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg': { sign: 'all', mode2: true },
  'trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg': { sign: 'all', mode2: true },
  'trpc.msg.msg_svc.MsgService.SsoReadedReport': { sign: 'all', mode2: true },
  'trpc.qqhb.qqhb_proxy.Handler.sso_handle': { sign: 'all', mode2: true },

  // ─── Linux 不签，Windows / macOS 签 ─────────────────────────────────
  'OidbSvcTrpcTcp.0x10c0_1': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0x10c0_2': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0x11e9_200': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0x11ea_200': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0x126d_200': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0x126e_200': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0x6d6_2': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0x6d6_3': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0x8fc_3': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0x902e_1': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0xa80_1': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0xe37_1200': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0xe37_1700': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0xe37_800': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0xfd4_1': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0xfe1_2': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0xfe5_2': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0xfe7_3': { sign: 'non-linux' },
  'HttpConn.0x6ff_501': { sign: 'non-linux' },
  'OidbSvc.0x480_9_IMCore': { sign: 'non-linux' },
  'OidbSvc.0x42d_4': { sign: 'non-linux' },

  // ─── macOS 不签，Linux / Windows 签 ─────────────────────────────────
  // 贴表情 / 撤回表情：macOS 版 QQ 确实不发 SecInfo（复测稳定，命令正常发出）。
  'OidbSvcTrpcTcp.0x9082_1': { sign: 'not-darwin', mode2: true },
  'OidbSvcTrpcTcp.0x9082_2': { sign: 'not-darwin', mode2: true },

  // ─── highway 上传申请（命令号来自参数，逐个列） ─────────────────────
  // 图片签名；语音 / 群视频不签；私聊视频 `0x11e9_100` 的 Windows 结果待补测，
  // 先按 macOS 实测的「签」处理。2026-11-09 实测见 docs/develop/sign-policy-20261109.md
  'OidbSvcTrpcTcp.0x11c4_100': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0x11c5_100': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0x11e9_100': { sign: 'non-linux' },

  // ─── 显式不签名（沿用原有协议策略，不改变线上参数） ──────────────────
  // 既有实测声明、抓包说明与间接依据分级见 docs/develop/sign-policy-20261109.md。
  'OidbSvcTrpcTcp.0x5d6_6': { sign: 'none' },
  'OidbSvcTrpcTcp.0x5d6_19': { sign: 'none' },
  'OidbSvcTrpcTcp.0x6d6_4': { sign: 'none' },
  'OidbSvcTrpcTcp.0x6d6_5': { sign: 'none' },
  'OidbSvcTrpcTcp.0x6d7_0': { sign: 'none' },
  'OidbSvcTrpcTcp.0x6d7_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0x6d7_2': { sign: 'none' },
  'OidbSvcTrpcTcp.0x6d8_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0x6d8_2': { sign: 'none' },
  'OidbSvcTrpcTcp.0x6d8_3': { sign: 'none' },
  'OidbSvcTrpcTcp.0x7e5_104': { sign: 'none' },
  'OidbSvcTrpcTcp.0x7ed_12': { sign: 'none' },
  'OidbSvcTrpcTcp.0x88d_110': { sign: 'none' },
  'OidbSvcTrpcTcp.0x8a0_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0x8a7_0': { sign: 'none' },
  'OidbSvcTrpcTcp.0x8b7_5': { sign: 'none' },
  'OidbSvcTrpcTcp.0x8fc_2': { sign: 'none' },
  'OidbSvcTrpcTcp.0xb5d_44': { sign: 'none' },
  'OidbSvcTrpcTcp.0xcd4_1': { sign: 'none' }, // 私聊正在输入
  'OidbSvcTrpcTcp.0xcde_2': { sign: 'none' },
  'OidbSvcTrpcTcp.0xd69_0': { sign: 'none' },
  'OidbSvcTrpcTcp.0xd72_0': { sign: 'none' },
  'OidbSvcTrpcTcp.0xdc2_34': { sign: 'none' },
  'OidbSvcTrpcTcp.0xe07_0': { sign: 'none' },
  'OidbSvcTrpcTcp.0xeac_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0xeac_2': { sign: 'none' },
  'OidbSvcTrpcTcp.0xeb7_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0xed3_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0x1096_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0x1097_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0x1124_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0x1125_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0x1126_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0x11ea_100': { sign: 'none' },
  'OidbSvcTrpcTcp.0x1253_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0x126d_100': { sign: 'none' },
  'OidbSvcTrpcTcp.0x126e_100': { sign: 'none' },
  'OidbSvcTrpcTcp.0x12a9_100': { sign: 'none' },
  'OidbSvcTrpcTcp.0x12a9_103': { sign: 'none' },
  'OidbSvcTrpcTcp.0x12b6_0': { sign: 'none' },
  'OidbSvcTrpcTcp.0x902f_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0x9067_202': { sign: 'none' }, // 图片下载 rkey
  'OidbSvcTrpcTcp.0x9083_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0x921b_0': { sign: 'none' },
  'OidbSvcTrpcTcp.0x929b_0': { sign: 'none' },
  'OidbSvcTrpcTcp.0x93cf_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0x93d0_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0x93d1_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0x93d3_1': { sign: 'none' },
  'OidbSvcTrpcTcp.0x93db_1': { sign: 'none' },
  // ─── 2026-11-13 Linux 真机实测（probe-sign，QQ 3.2.35-54395）────────────────
  // 这批是从 SnowLuma 搬入的新命令。全部实测**不签名**（reserved 完整解析、
  // 无 tag 24）；其中 0xfd4_1 / 0xfe5_2 用真实业务正文复测过，不是占位正文。
  // Windows / macOS 当时未测，先按 Linux 结论登记；其中 0xf16_1 已于
  // 2026-11-14 在两端补测，同样不签（见下方那批），其余待测。
  'OidbSvcTrpcTcp.0x126b_0': { sign: 'none' }, // 删好友
  'OidbSvcTrpcTcp.0x912e_0': { sign: 'none' }, // 设好友备注（2026-11-13 Linux 实测）
  'OidbSvcTrpcTcp.0x912f_0': { sign: 'none' }, // 清好友备注（同族，Linux 实测不签）
  'OidbSvcTrpcTcp.0x9154_1': { sign: 'none' }, // 系统表情目录
  'OidbSvcTrpcTcp.0x9155_1': { sign: 'none' }, // 单个系统表情
  'OidbSvcTrpcTcp.0x496_0': { sign: 'none' }, // 机器人号段
  'OidbSvcTrpcTcp.0x990_2': { sign: 'none' }, // 英译中
  'OidbSvcTrpcTcp.0x93d2_1': { sign: 'none' }, // 闪传列表
  'OidbSvcTrpcTcp.0x9407_1': { sign: 'none' }, // 删闪传文件
  'OidbSvcTrpcTcp.0x9427_0': { sign: 'none' }, // 重命名闪传文件（sub=0 + uinForm）
  'OidbSvcTrpcTcp.0x9164_2': { sign: 'none' }, // 读管理员权限
  'OidbSvcTrpcTcp.0x9c1c_2': { sign: 'none' }, // 写管理员权限
  'OidbSvcTrpcTcp.0x904_1': { sign: 'none' }, // 写管理员接收验证
  'OidbSvcTrpcTcp.0xfe7_4': { sign: 'none' }, // 读管理员接收验证
  'OidbSvcTrpcTcp.0xef0_1': { sign: 'none' }, // 读群扩展信息
  'OidbSvcTrpcTcp.0xf00_3': { sign: 'none' }, // 写群扩展信息
  'OidbSvcTrpcTcp.0x9436_0': { sign: 'none' },
  'OidbSvcTrpcTcp.0x9437_0': { sign: 'none' },
  'OidbSvcTrpcTcp.0x9474_0': { sign: 'none' }, // 群待办列表
  'OidbSvcTrpcTcp.0x967c_0': { sign: 'none' },
  'OidbSvcTrpcTcp.0x967d_0': { sign: 'none' },
  'OidbSvcTrpcTcp.0x967e_0': { sign: 'none' },
  'OidbSvcTrpcTcp.0xfe1_3': { sign: 'none' }, // QQ 秀形象查询，不能套用 0xfe1_2 的规则
  'trpc.msg.msg_svc.MsgService.SsoGroupRecallMsg': { sign: 'none' },
  'trpc.msg.register_proxy.RegisterProxy.SsoGetGroupMsg': { sign: 'none' },
  'trpc.msg.register_proxy.RegisterProxy.SsoGetC2cMsg': { sign: 'none' },
  'trpc.qq_new_tech.status_svc.StatusService.SetStatus': { sign: 'none' },
  'trpc.qpay.red_pack_skin.Skin.SsoGetSkinInfo': { sign: 'none' },
  'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList': { sign: 'none' },
  'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.DeleteMedias': { sign: 'none' },
  'QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunLike': { sign: 'none' },
  'QunAlbum.trpc.qzone.webapp_qun_feeds.FeedsReader.GetQunFeedDetail': { sign: 'none' },
  'QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunComment': { sign: 'none' },
  // ─── 2026-11-14 Windows / macOS 真机实测（probe-sign）──────────────────────
  // 这批此前只有「未实测」的记录，运行时静默按不签名发包。2026-11-14 在
  // Windows（QQ 9.9.35）与 macOS 分别实测，20 条**全部不签名**（reserved
  // 完整解析、无 tag 24，命令正常发出）。Linux 未单独复测，按两端结论推断。
  'MQUpdateSvc_com_qq_ti.web.OidbSvc.0xeb1_1': { sign: 'none' }, // 好友线索
  'OidbSvc.0x4ff_9_IMCore': { sign: 'none' }, // 旧资料写入
  'OidbSvc.0xcf4': { sign: 'none' }, // 共同群查询
  'OidbSvcTrpcTcp.0x10eb_1': { sign: 'none' }, // 好友跨分组移动
  'OidbSvcTrpcTcp.0x1255_0': { sign: 'none' }, // 好友分组设置
  'OidbSvcTrpcTcp.0x1290_0': { sign: 'none' }, // 已废弃的群通话 OIDB 旧模型
  'OidbSvcTrpcTcp.0x1291_0': { sign: 'none' }, // 同上
  'OidbSvcTrpcTcp.0x1292_0': { sign: 'none' }, // 同上
  'OidbSvcTrpcTcp.0x5d6_1': { sign: 'none' }, // 群置顶
  'OidbSvcTrpcTcp.0x5d6_18': { sign: 'none' }, // 好友置顶
  'OidbSvcTrpcTcp.0x6d6_0': { sign: 'none' }, // 群文件上传申请
  'OidbSvcTrpcTcp.0xf16_1': { sign: 'none' }, // 群备注
  'OidbSvcTrpcTcp.0xf90_1': { sign: 'none' }, // 设置群待办
  'OidbSvcTrpcTcp.0xf90_2': { sign: 'none' }, // 完成群待办
  'OidbSvcTrpcTcp.0xf90_3': { sign: 'none' }, // 取消群待办
  'pttTrans.TransC2CPttReq': { sign: 'none' }, // 私聊语音转写
  'pttTrans.TransGroupPttReq': { sign: 'none' }, // 群语音转写
  'trpc.qqrtc.av_appsvr.AvAppsvr.SsoAcceptInvite': { sign: 'none' },
  'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoDeleteUser': { sign: 'none' },
  'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoEnterRoom': { sign: 'none' },
  'Faceroam.OpReq': { sign: 'none' },
  'ImgStore.BDHExpressionRoam': { sign: 'none' },
  'scupdate.handle': { sign: 'none' },
  'LongConn.OffPicUp': { sign: 'none' },
  'QQLBSShareSvc.room_operation': { sign: 'none' },
  'QQLBSShareSvc.report_location': { sign: 'none' },
  'QQLBSShareSvc.room_query': { sign: 'none' },
  'trpc.qqhb.hbpanel.Hongbao.SsoGetToken': { sign: 'none' },
  'trpc.qq_lbs.qq_lbs_ark.LocationArk.SsoSendMessage': { sign: 'none' },
  'trpc.qqrtc.av_appsvr.AvAppsvr.SsoCreateRoom': { sign: 'none' },
  'trpc.qqrtc.av_appsvr.AvAppsvr.SsoInviteUser': { sign: 'none' },
  'trpc.qqrtc.av_appsvr.AvAppsvr.SsoLogOut': { sign: 'none' },
  'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoCreateRoom': { sign: 'none' },
  'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoInviteRoom': { sign: 'none' },
  'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoQueryRoom': { sign: 'none' },
  'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoMultiTerminalSync': { sign: 'none' },
  'trpc.qqva.gift_midground_panel.GiftMidgroundPanel.SsoGetSceneItem': { sign: 'none' },
} as const satisfies Record<string, SignRule>;

/**
 * 无逐命令签名依据的现有入口；不把默认 false 登记成已确认的不签名策略。
 *
 * 2026-11-14 起原先 20 条「未实测」命令在 Windows / macOS 实测后全部转入
 * `SIGN_RULES` 的 `sign: 'none'`；仅剩单向好友仍缺三端实测依据。
 * 新增入口若缺依据，仍登记到这里。
 */
export const UNCONFIRMED_SIGN_COMMANDS: Readonly<Record<string, string>> = {
  'MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0': '单向好友：JSON 自定义传输，三端签名未实测',
};

/** 表里出现过的 wire 命令。 */
export type SignedCommand = keyof typeof SIGN_RULES;

/** OIDB 命令号 + 子命令 → wire 命令字符串（和抓包/线上完全一致）。 */
export function oidbCommand(command: number, subCommand: number): string {
  return `OidbSvcTrpcTcp.0x${command.toString(16)}_${subCommand}`;
}

function needSignOn(rule: SignRuleSwitch | PerPlatform, platform: NodeJS.Platform): boolean {
  if (rule === 'all') return true;
  if (rule === 'none') return false;
  if (rule === 'non-linux') return platform !== 'linux';
  if (rule === 'not-darwin') return platform !== 'darwin';
  if (platform === 'win32') return rule.win32;
  if (platform === 'darwin') return rule.darwin;
  return rule.linux;
}

/** 查不到的 OIDB / raw 命令只提示一次，避免轮询时刷屏。 */
const warned = new Set<string>();

/**
 * 把 wire 命令解析成当前平台要传给 native 的 `(needSign, mode)`。
 *
 * 表里没有的命令按「不签名 + 精简签名」处理，并打一条 warn —— 新加协议时忘了
 * 登记会在这里暴露，而不是静默按某个平台的猜测发包。
 */
export function resolveSign(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
): ResolvedSign {
  const rule = SIGN_RULES[cmd as SignedCommand] as SignRule | undefined;
  if (!rule) {
    if (!warned.has(cmd)) {
      warned.add(cmd);
      console.warn(
        `[sign-policy] 未登记的命令 ${cmd}，按 needSign=false / mode=3 处理；` +
          (UNCONFIRMED_SIGN_COMMANDS[cmd]
            ? `待确认：${UNCONFIRMED_SIGN_COMMANDS[cmd]}。`
            : '如果 QQ 本体对它会签名，请加进 SIGN_RULES（scripts/probe-sign.ts 可测）。'),
      );
    }
    return { needSign: false, mode: 3 };
  }
  const needSign = needSignOn(rule.sign, platform);
  // 不签名时 native 根本不调签名器（`sec_info` 直接返回 None），mode 无从生效。
  // 这种情况一律给 3，不要报一个「这条命令在 macOS 上是 mode=2」但实际上从未
  // 被使用、也没有实测依据的值 —— `0x9082_1/2` 就是这种：macOS 不签，mode 未知。
  // 其余情况：mode 只在 macOS / Windows 的 VM ABI 里有，Linux 恒为 3。
  const mode: SignMode = needSign && platform !== 'linux' && rule.mode2 ? 2 : 3;
  return { needSign, mode };
}
