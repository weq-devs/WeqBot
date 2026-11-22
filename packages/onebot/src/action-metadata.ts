/**
 * action 的文档元数据：一句话描述 + 入参 JSON Schema。
 *
 * 与 NapCat 的 `payloadSchema` / SnowLuma 的 `describe().inputSchema` 同用途：
 * 这是给未来的 API 文档、调试页 / 测试页消费的**纯元数据**，不参与运行时分发。
 * 真正的参数校验仍在各 action 的 `parse` 里 —— 这里有两点约定：
 *
 *   - 描述缺省时由注册表的 `describe()` 回退到 action 自己的 `summary`；
 *   - Schema 描述的是「调用方应该传什么」，而不是内部规范化后的字段名。
 *     例如 `group_id` / `user_id` 保持 OneBot 原始拼写。
 *
 * `additionalProperties: true` 是有意的：OneBot 客户端常带 `auto_escape` 之类的
 * 兼容字段，文档页不应把它们标成非法。
 */

export type JsonSchema = Record<string, unknown>;

export interface ActionMetadata {
  /** 比 `summary` 更长的说明；不填时 `describe()` 用 summary。 */
  description?: string;
  /** 整个 params 对象的 JSON Schema（OpenAPI 3.1 兼容）。 */
  inputSchema: JsonSchema;
}

function int(description: string, extra: JsonSchema = {}): JsonSchema {
  return { type: 'integer', description, ...extra };
}

function str(description: string, extra: JsonSchema = {}): JsonSchema {
  return { type: 'string', description, ...extra };
}

function bool(description: string, extra: JsonSchema = {}): JsonSchema {
  return { type: 'boolean', description, ...extra };
}

function arrayOf(description: string, items?: JsonSchema): JsonSchema {
  return { type: 'array', description, ...(items ? { items } : {}) };
}

function object(description: string): JsonSchema {
  return { type: 'object', description, additionalProperties: true };
}

function optionalObject(description: string): JsonSchema {
  return { type: 'object', description, additionalProperties: true };
}

function enumOf(description: string, values: readonly (string | number)[]): JsonSchema {
  return { type: 'string', description, enum: [...values] };
}

function stringOrArray(description: string): JsonSchema {
  return {
    description,
    anyOf: [
      { type: 'string', minLength: 1 },
      { type: 'array', minItems: 1, items: { type: 'string' } },
    ],
  };
}

/** OneBot `message`：CQ 码字符串 / segment 数组 / 单个 segment 对象。 */
function messageSchema(description = '消息内容：CQ 码字符串或消息段数组'): JsonSchema {
  return {
    description,
    anyOf: [
      { type: 'string' },
      { type: 'array', items: { type: 'object', additionalProperties: true } },
      { type: 'object', additionalProperties: true },
    ],
  };
}

const groupId = (description = '群号') => int(description, { minimum: 1, 'x-role': 'group_id' });
const userId = (description = 'QQ 号') => int(description, { minimum: 1, 'x-role': 'user_id' });
const memberId = (description = '群成员 QQ 号') =>
  int(description, { minimum: 1, 'x-role': 'member_id' });
const messageId = (description = '消息 ID（OneBot 分配的整数）') =>
  int(description, { 'x-role': 'message_id' });
const fileId = (description = '文件 ID') => str(description, { 'x-role': 'file_id' });
const fileSource = (description = '本机文件路径') => str(description, { 'x-role': 'file' });
const imageSource = (description = '图片：base64 / data: / http(s) URL / 本机路径') =>
  str(description, { 'x-role': 'image' });
const faceId = (description = 'QQ 表情 id，0 合法') =>
  int(description, { minimum: 0, 'x-role': 'face_id' });

function input(properties: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchema {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: true,
  };
}

const EMPTY_INPUT = input();

const autoEscape = bool('为 true 时把 message 整段当作纯文本，不解析 CQ 码');
const forwardPreviewProperties: Record<string, JsonSchema> = {
  source: str('合并转发卡片来源，例如「群聊的聊天记录」'),
  summary: str('卡片摘要，例如「查看 3 条转发消息」'),
  prompt: str('卡片底部提示，例如「QQ 小程序」'),
  news: arrayOf('卡片预览条目；字符串或 { text } 对象', {
    anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }],
  }),
};

function forwardInput(target: 'group' | 'private' | 'auto'): JsonSchema {
  const nodes = arrayOf('转发节点数组；每项为 { type: "node", data } 或裸节点对象');
  const properties: Record<string, JsonSchema> = {
    messages: nodes,
    message: nodes,
  };
  if (target !== 'private') properties.group_id = groupId();
  if (target !== 'group') properties.user_id = userId();
  if (target === 'auto') {
    properties.message_type = enumOf('路由类型；不传时按 group_id / user_id 推断', [
      'group',
      'private',
    ]);
  }
  Object.assign(properties, forwardPreviewProperties);
  // messages / message 互为别名，任一即可；跨字段约束在 parse 里校验。
  return input(properties);
}

export const ACTION_METADATA: Record<string, ActionMetadata> = {
  // ─────────────────────────── 消息 ───────────────────────────
  send_group_msg: {
    description: '向指定群发送一条消息；message 支持字符串 / 消息段数组。',
    inputSchema: input({ group_id: groupId(), message: messageSchema(), auto_escape: autoEscape }, [
      'group_id',
      'message',
    ]),
  },
  send_private_msg: {
    description: '向指定好友发送私聊消息；传 group_id 时按临时会话发送。',
    inputSchema: input(
      {
        user_id: userId(),
        group_id: groupId('临时会话来源群号，仅私聊时使用'),
        message: messageSchema(),
        auto_escape: autoEscape,
      },
      ['user_id', 'message'],
    ),
  },
  send_msg: {
    description:
      '统一发送入口：message_type=group 用 group_id，message_type=private 用 user_id；未传 message_type 时按传了哪个 id 推断。',
    inputSchema: input(
      {
        message_type: enumOf('消息类型；不传时自动推断', ['group', 'private']),
        group_id: groupId(),
        user_id: userId(),
        message: messageSchema(),
        auto_escape: autoEscape,
        font_id: int('本条消息的聊天字体 ID', { minimum: 1, maximum: 65535 }),
      },
      ['message'],
    ),
  },
  delete_msg: {
    description: '撤回本进程收到或发出过的消息；未知 message_id 返回 1400。',
    inputSchema: input({ message_id: messageId() }, ['message_id']),
  },
  get_msg: {
    description: '从进程内消息缓存取完整事件快照，并补 real_id。',
    inputSchema: input({ message_id: messageId() }, ['message_id']),
  },
  can_send_image: { inputSchema: EMPTY_INPUT },
  can_send_record: { inputSchema: EMPTY_INPUT },
  get_status: { inputSchema: EMPTY_INPUT },
  get_version_info: { inputSchema: EMPTY_INPUT },
  get_group_msg_history: {
    description: '按 message_id 或本进程最后一条消息作锚点拉群历史；message_id=0 表示最新。',
    inputSchema: input(
      {
        group_id: groupId(),
        message_id: int('分页锚点；0 表示最新', { default: 0 }),
        count: int('拉取条数，服务端上限 200', { minimum: 0, maximum: 200, default: 20 }),
        reverse_order: bool('是否按从旧到新返回', { default: true }),
      },
      ['group_id'],
    ),
  },
  get_friend_msg_history: {
    description: '按 message_id 或本进程最后一条消息作锚点拉好友历史；message_id=0 表示最新。',
    inputSchema: input(
      {
        user_id: userId(),
        message_id: int('分页锚点；0 表示最新', { default: 0 }),
        count: int('拉取条数，服务端上限 200', { minimum: 0, maximum: 200, default: 20 }),
        reverse_order: bool('是否按从旧到新返回', { default: true }),
      },
      ['user_id'],
    ),
  },
  get_forward_msg: {
    description: '用合并转发 id 取节点；只给 message_id 时从消息缓存里找 forward 段的 id。',
    inputSchema: input({
      id: str('合并转发 res_id'),
      message_id: str('消息 ID，可从中反查 forward 段 id'),
    }),
  },
  upload_forward_msg: {
    description: '只上传合并转发资源，不发送；返回 res_id。',
    inputSchema: input({
      messages: arrayOf('转发节点数组；每项为 { type: "node", data } 或裸节点对象'),
      message: arrayOf('messages 的别名'),
      group_id: groupId('上传目标群；不传时按私聊资源处理'),
    }),
  },
  upload_foward_msg: {
    description: 'upload_forward_msg 的 SnowLuma 拼写别名，参数完全相同。',
    inputSchema: input({
      messages: arrayOf('转发节点数组；每项为 { type: "node", data } 或裸节点对象'),
      message: arrayOf('messages 的别名'),
      group_id: groupId('上传目标群；不传时按私聊资源处理'),
    }),
  },
  send_forward_msg: {
    description:
      '发送合并转发；group_id / user_id 都不传时只上传不发送，message_type 可显式指定路由。',
    inputSchema: forwardInput('auto'),
  },
  send_group_forward_msg: {
    inputSchema: forwardInput('group'),
  },
  send_private_forward_msg: {
    inputSchema: forwardInput('private'),
  },
  mark_group_msg_as_read: {
    inputSchema: input({ message_id: int('群消息 ID'), group_id: groupId('可选校验群号') }, [
      'message_id',
    ]),
  },
  mark_private_msg_as_read: {
    inputSchema: input({ message_id: int('私聊消息 ID'), user_id: userId('可选校验 QQ 号') }, [
      'message_id',
    ]),
  },
  mark_msg_as_read: {
    description: '按 message_id 所属会话自动选择群 / 私聊已读上报。',
    inputSchema: input({ message_id: int('消息 ID'), target_id: int('可选校验会话 id') }, [
      'message_id',
    ]),
  },
  forward_friend_single_msg: {
    inputSchema: input({ message_id: int('消息 ID'), user_id: userId() }, [
      'message_id',
      'user_id',
    ]),
  },
  forward_group_single_msg: {
    inputSchema: input({ message_id: int('消息 ID'), group_id: groupId() }, [
      'message_id',
      'group_id',
    ]),
  },
  send_custom_face: {
    description: '发送账号收藏表情；group_id 与 user_id 必须且只能给一个。',
    inputSchema: input(
      {
        emoji_id: str('收藏表情 id 或 MD5'),
        group_id: groupId(),
        user_id: userId(),
        reply_to: int('要回复的消息 ID'),
      },
      ['emoji_id'],
    ),
  },

  // ─────────────────────────── 名单 / 资料 ───────────────────────────
  get_login_info: { inputSchema: EMPTY_INPUT },
  get_friend_list: { inputSchema: EMPTY_INPUT },
  get_group_list: { inputSchema: EMPTY_INPUT },
  get_group_info: { inputSchema: input({ group_id: groupId() }, ['group_id']) },
  get_group_member_list: { inputSchema: input({ group_id: groupId() }, ['group_id']) },
  get_group_member_info: {
    inputSchema: input({ group_id: groupId(), user_id: memberId() }, ['group_id', 'user_id']),
  },
  get_stranger_info: { inputSchema: input({ user_id: userId() }, ['user_id']) },

  // ─────────────────────────── 群管理 ───────────────────────────
  set_group_card: {
    inputSchema: input(
      { group_id: groupId(), user_id: memberId(), card: str('新群名片；空字符串表示清除') },
      ['group_id', 'user_id', 'card'],
    ),
  },
  set_group_ban: {
    description: '禁言指定成员；duration 为秒，0 表示解除禁言。',
    inputSchema: input(
      {
        group_id: groupId(),
        user_id: memberId(),
        duration: int('禁言秒数；0 表示解除', { minimum: 0 }),
      },
      ['group_id', 'user_id', 'duration'],
    ),
  },
  set_group_whole_ban: {
    inputSchema: input(
      { group_id: groupId(), enable: bool('true 开启全员禁言', { default: true }) },
      ['group_id'],
    ),
  },
  set_group_admin: {
    inputSchema: input(
      {
        group_id: groupId(),
        user_id: memberId(),
        enable: bool('true 设为管理员', { default: true }),
      },
      ['group_id', 'user_id'],
    ),
  },
  set_group_name: {
    inputSchema: input({ group_id: groupId(), group_name: str('新群名') }, [
      'group_id',
      'group_name',
    ]),
  },
  set_group_kick: {
    inputSchema: input(
      {
        group_id: groupId(),
        user_id: memberId(),
        reject_add_request: bool('是否同时拒绝其再加群'),
      },
      ['group_id', 'user_id'],
    ),
  },
  set_group_leave: {
    inputSchema: input({ group_id: groupId(), is_dismiss: bool('群主解散群时为 true') }, [
      'group_id',
    ]),
  },
  set_group_special_title: {
    description: '设置群头衔；duration=-1 或省略表示永久。',
    inputSchema: input(
      {
        group_id: groupId(),
        user_id: memberId(),
        special_title: str('头衔文本；空字符串表示清除'),
        duration: int('有效期秒数；-1 表示永久', { minimum: -1 }),
      },
      ['group_id', 'user_id'],
    ),
  },
  set_essence_msg: {
    inputSchema: input({ message_id: int('群消息 ID') }, ['message_id']),
  },
  delete_essence_msg: {
    inputSchema: input({ message_id: int('群消息 ID') }, ['message_id']),
  },
  set_group_remark: {
    inputSchema: input({ group_id: groupId(), remark: str('群备注') }, ['group_id', 'remark']),
  },
  get_group_info_ex: { inputSchema: input({ group_id: groupId() }, ['group_id']) },
  get_group_detail_info: { inputSchema: input({ group_id: groupId() }, ['group_id']) },
  set_group_kick_members: {
    description: '批量踢人；user_id 既接受单个 QQ 号，也接受 QQ 号数组。',
    inputSchema: input(
      {
        group_id: groupId(),
        user_id: {
          description: '单个 QQ 号或 QQ 号数组',
          anyOf: [
            { type: 'integer', minimum: 1 },
            { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } },
          ],
        },
        reject_add_request: bool('是否同时拒绝其再加群', { default: false }),
      },
      ['group_id', 'user_id'],
    ),
  },
  set_group_add_option: {
    inputSchema: input(
      {
        group_id: groupId(),
        add_type: int('加群方式', { minimum: 0, default: 0 }),
        group_question: str('加群问题'),
        group_answer: str('加群答案'),
      },
      ['group_id'],
    ),
  },
  get_group_tags: {
    inputSchema: input({ group_class: int('群分类 id', { minimum: 0 }) }, ['group_class']),
  },
  add_group_tag: {
    inputSchema: input(
      {
        group_class: int('群分类 id', { minimum: 0 }),
        name: str('资料标签名'),
      },
      ['group_class', 'name'],
    ),
  },
  delete_group_tag: {
    inputSchema: input(
      {
        group_class: int('群分类 id', { minimum: 0 }),
        name: str('资料标签名'),
      },
      ['group_class', 'name'],
    ),
  },
  get_group_admin_permissions: {
    inputSchema: input({ group_id: groupId(), user_id: memberId() }, ['group_id', 'user_id']),
  },
  set_group_admin_permissions: {
    description: '修改管理员权限；开启踢人时必须给 kick_member_per_day，关闭时不能给。',
    inputSchema: input(
      {
        group_id: groupId(),
        user_id: memberId(),
        recall_member_message: bool('是否允许撤回群成员消息'),
        kick_member: bool('是否允许踢人'),
        kick_member_per_day: {
          type: 'integer',
          description: '每日踢人上限，仅 kick_member=true 时使用',
          enum: [0, 5, 10, 20, 50, 100, 200],
        },
      },
      ['group_id', 'user_id'],
    ),
  },
  set_group_admin_receive_verify: {
    inputSchema: input(
      { group_id: groupId(), user_id: memberId(), enable: bool('是否接收加群验证消息') },
      ['group_id', 'user_id', 'enable'],
    ),
  },
  set_group_robot_add_option: {
    description: '至少提供 robot_member_switch 或 robot_member_examine 之一。',
    inputSchema: input(
      {
        group_id: groupId(),
        robot_member_switch: int('机器人入群开关', { minimum: 0 }),
        robot_member_examine: int('机器人入群审核方式', { minimum: 0 }),
      },
      ['group_id'],
    ),
  },
  set_group_portrait: {
    inputSchema: input(
      { group_id: groupId(), file: imageSource('群头像：base64 / data: / 本机路径') },
      ['group_id', 'file'],
    ),
  },
  get_group_system_msg: {
    inputSchema: input({
      group_id: groupId('只看指定群；不传表示全部'),
      only_pending: bool('只返回待处理请求', { default: false }),
      count: int('最多返回条数', { minimum: 1, maximum: 100, default: 50 }),
    }),
  },
  set_group_search: {
    description: '至少提供 no_finger_open 或 no_code_finger_open 之一。',
    inputSchema: input(
      {
        group_id: groupId(),
        no_finger_open: int('群号搜索开关', { minimum: 0 }),
        no_code_finger_open: int('群二维码搜索开关', { minimum: 0 }),
      },
      ['group_id'],
    ),
  },
  set_group_member_invite_policy: {
    inputSchema: input(
      {
        group_id: groupId(),
        policy: enumOf('邀请策略', [
          'disabled',
          'require_approval',
          'no_approval',
          'no_approval_under_100',
        ]),
      },
      ['group_id', 'policy'],
    ),
  },
  set_group_new_member_history_visibility: {
    inputSchema: input({ group_id: groupId(), visible: bool('新成员是否可查看历史消息') }, [
      'group_id',
      'visible',
    ]),
  },
  set_group_member_permissions: {
    description: '至少传入一个成员权限字段；未传的字段保持不变。',
    inputSchema: input({
      group_id: groupId(),
      allow_member_upload_album: bool('允许成员上传群相册'),
      allow_member_temporary_session: bool('允许成员发起临时会话'),
      allow_member_create_group: bool('允许成员发起新群聊'),
    }),
  },
  get_group_admin_settings: {
    inputSchema: input({ group_id: groupId() }, ['group_id']),
  },

  // ─────────────────────────── 互动 / 请求 ───────────────────────────
  send_like: {
    inputSchema: input({ user_id: userId(), times: int('点赞次数', { minimum: 1, default: 1 }) }, [
      'user_id',
    ]),
  },
  send_poke: {
    description: '戳一戳；传 group_id 时在群内戳，否则按好友私聊戳。',
    inputSchema: input({ user_id: userId(), group_id: groupId('群号；不传表示私聊') }, ['user_id']),
  },
  friend_poke: {
    inputSchema: input({ user_id: userId(), target_id: userId('可选拍一拍目标') }, ['user_id']),
  },
  group_poke: {
    inputSchema: input({ group_id: groupId(), user_id: memberId() }, ['group_id', 'user_id']),
  },
  set_friend_add_request: {
    inputSchema: input(
      {
        flag: str('好友申请 flag，来自事件上报'),
        approve: bool('true 同意 / false 拒绝'),
        remark: str('同意后的好友备注'),
      },
      ['flag', 'approve'],
    ),
  },
  set_group_add_request: {
    inputSchema: input(
      {
        flag: str('加群申请 flag，来自事件上报'),
        approve: bool('true 同意 / false 拒绝'),
        reason: str('拒绝理由'),
      },
      ['flag', 'approve'],
    ),
  },
  click_inline_keyboard_button: {
    inputSchema: input(
      {
        group_id: groupId(),
        bot_appid: int('机器人 appid', { minimum: 1 }),
        msg_seq: int('消息 seq', { minimum: 1 }),
        button_id: str('按钮 id'),
        callback_data: str('按钮回调数据'),
      },
      ['group_id', 'bot_appid', 'msg_seq', 'button_id'],
    ),
  },

  // ─────────────────────────── 群文件 ───────────────────────────
  get_group_root_files: { inputSchema: input({ group_id: groupId() }, ['group_id']) },
  get_group_files_by_folder: {
    inputSchema: input(
      {
        group_id: groupId(),
        folder_id: str('文件夹 id；空值表示根目录', { 'x-role': 'file_id' }),
        folder: str('folder_id 的 SnowLuma 别名'),
      },
      ['group_id'],
    ),
  },
  get_group_file_url: {
    inputSchema: input(
      {
        group_id: groupId(),
        file_id: fileId(),
        busid: int('业务 id', { minimum: 1, default: 102 }),
      },
      ['group_id', 'file_id'],
    ),
  },
  get_group_file_system_info: {
    inputSchema: input({ group_id: groupId() }, ['group_id']),
  },
  delete_group_file: {
    inputSchema: input({ group_id: groupId(), file_id: fileId() }, ['group_id', 'file_id']),
  },
  move_group_file: {
    inputSchema: input(
      {
        group_id: groupId(),
        file_id: fileId(),
        current_parent_directory: str('文件当前所在文件夹', { default: '/' }),
        target_parent_directory: str('目标文件夹'),
      },
      ['group_id', 'file_id', 'target_parent_directory'],
    ),
  },
  rename_group_file: {
    inputSchema: input(
      {
        group_id: groupId(),
        file_id: fileId(),
        current_parent_directory: str('文件当前所在文件夹', { default: '/' }),
        new_name: str('新文件名'),
      },
      ['group_id', 'file_id', 'new_name'],
    ),
  },
  create_group_file_folder: {
    inputSchema: input({ group_id: groupId(), name: str('文件夹名') }, ['group_id', 'name']),
  },
  delete_group_file_folder: {
    inputSchema: input(
      { group_id: groupId(), folder_id: str('文件夹 id', { 'x-role': 'file_id' }) },
      ['group_id', 'folder_id'],
    ),
  },
  get_private_file_url: {
    inputSchema: input(
      {
        user_id: userId('文件所属好友；可省略'),
        file_id: fileId(),
        file_hash: str('文件 hash'),
      },
      ['file_id'],
    ),
  },
  rename_group_file_folder: {
    inputSchema: input(
      {
        group_id: groupId(),
        folder_id: str('文件夹 id', { 'x-role': 'file_id' }),
        new_name: str('新文件夹名'),
      },
      ['group_id', 'folder_id', 'new_name'],
    ),
  },
  delete_group_folder: {
    inputSchema: input(
      { group_id: groupId(), folder_id: str('文件夹 id', { 'x-role': 'file_id' }) },
      ['group_id', 'folder_id'],
    ),
  },
  trans_group_file: {
    inputSchema: input({ group_id: groupId(), file_id: fileId() }, ['group_id', 'file_id']),
  },
  upload_group_file: {
    description: '上传本机文件到群文件；只接受本机路径，不接受远程 URL / base64。',
    inputSchema: input(
      {
        group_id: groupId(),
        file: fileSource('本机文件路径，支持 file://'),
        name: str('上传后的文件名'),
        folder: str('目标文件夹 id；默认根目录'),
        folder_id: str('目标文件夹 id（folder 的别名）'),
        upload_file: bool('true 上传并发布，false 只上传', { default: true }),
      },
      ['group_id', 'file'],
    ),
  },
  upload_private_file: {
    description: '上传本机文件到好友私聊；只接受本机路径。',
    inputSchema: input(
      {
        user_id: userId(),
        file: fileSource('本机文件路径，支持 file://'),
        name: str('上传后的文件名'),
        upload_file: bool('true 上传并发送', { default: true }),
      },
      ['user_id', 'file'],
    ),
  },

  // ─────────────────────────── 扩展：收藏表情 / 系统表情 / 回应 ───────────────────────────
  add_custom_face: {
    inputSchema: input({ file: imageSource('收藏表情图片：base64 / data: / 本机路径') }, ['file']),
  },
  fetch_custom_face: { inputSchema: EMPTY_INPUT },
  fetch_custom_face_detail: {
    inputSchema: input({ emoji_ids: stringOrArray('要查询的收藏表情 id 列表') }, ['emoji_ids']),
  },
  modify_custom_face: {
    inputSchema: input({ emoji_id: str('收藏表情 id'), desc: str('新备注') }, ['emoji_id']),
  },
  move_custom_face_to_front: {
    inputSchema: input({ emoji_id: str('收藏表情 id') }, ['emoji_id']),
  },
  delete_custom_face: {
    inputSchema: input({ emoji_ids: stringOrArray('要删除的收藏表情 id 列表') }, ['emoji_ids']),
  },
  fetch_sys_faces: { inputSchema: EMPTY_INPUT },
  search_sys_faces: {
    inputSchema: input({ keyword: str('关键字：名称 / face id / emoji id') }, ['keyword']),
  },
  fetch_face_entity: {
    inputSchema: input({ face_id: int('系统表情 face id', { minimum: 1 }) }, ['face_id']),
  },
  get_emoji_likes: {
    inputSchema: input(
      {
        message_id: messageId('群消息 ID'),
        emoji_id: str('表情 id'),
        count: int('最多返回条数', { minimum: 1 }),
        cookie: str('分页 cookie'),
      },
      ['message_id', 'emoji_id'],
    ),
  },
  get_msg_emoji_likes: {
    inputSchema: input(
      {
        message_id: messageId('群消息 ID'),
        emoji_id: str('表情 id'),
        count: int('最多返回条数', { minimum: 1 }),
        cookie: str('分页 cookie'),
      },
      ['message_id', 'emoji_id'],
    ),
  },
  fetch_emoji_like: {
    inputSchema: input(
      {
        message_id: messageId('群消息 ID'),
        emoji_id: str('表情 id'),
        count: int('最多返回条数', { minimum: 1 }),
        cookie: str('分页 cookie'),
      },
      ['message_id', 'emoji_id'],
    ),
  },
  fetch_emoji_likes: {
    inputSchema: input(
      {
        message_id: messageId('群消息 ID'),
        emoji_id: str('表情 id'),
        count: int('最多返回条数', { minimum: 1 }),
        cookie: str('分页 cookie'),
      },
      ['message_id', 'emoji_id'],
    ),
  },
  set_msg_emoji_like: {
    inputSchema: input(
      {
        message_id: messageId('群消息 ID'),
        emoji_id: str('表情 id'),
        set: bool('true 贴上，false 撤销', { default: true }),
      },
      ['message_id', 'emoji_id'],
    ),
  },
  set_group_reaction: {
    inputSchema: input(
      {
        message_id: messageId('群消息 ID'),
        emoji_id: str('表情 id'),
        set: bool('true 贴上，false 撤销', { default: true }),
      },
      ['message_id', 'emoji_id'],
    ),
  },
  set_group_todo: {
    description: '用 message_id 定位，或显式提供成对的 group_id + msg_seq。',
    inputSchema: input({
      message_id: messageId('群消息 ID'),
      group_id: groupId('显式群号；必须与 msg_seq 成对'),
      msg_seq: int('显式消息 seq；必须与 group_id 成对', { minimum: 1 }),
    }),
  },
  complete_group_todo: {
    description: '用 message_id 定位，或显式提供成对的 group_id + msg_seq。',
    inputSchema: input({
      message_id: messageId('群消息 ID'),
      group_id: groupId('显式群号；必须与 msg_seq 成对'),
      msg_seq: int('显式消息 seq；必须与 group_id 成对', { minimum: 1 }),
    }),
  },
  cancel_group_todo: {
    description: '用 message_id 定位，或显式提供成对的 group_id + msg_seq。',
    inputSchema: input({
      message_id: messageId('群消息 ID'),
      group_id: groupId('显式群号；必须与 msg_seq 成对'),
      msg_seq: int('显式消息 seq；必须与 group_id 成对', { minimum: 1 }),
    }),
  },
  get_group_todo_list: { inputSchema: input({ group_id: groupId() }, ['group_id']) },
  get_group_at_all_remain: { inputSchema: input({ group_id: groupId() }, ['group_id']) },
  translate_en2zh: {
    inputSchema: input({ words: arrayOf('要翻译的英文单词列表', { type: 'string' }) }, ['words']),
  },

  // ─────────────────────────── 扩展：Ark / AI 语音 / 好友 ───────────────────────────
  share_peer: {
    description: '生成推荐 Ark 卡片；user_id 与 group_id 至少给一个。',
    inputSchema: input({
      group_id: groupId(),
      user_id: userId(),
      phone_number: str('可选手机号'),
    }),
  },
  send_ark_share: {
    description: 'NapCat 标准名；与 share_peer 同形。',
    inputSchema: input({
      group_id: groupId(),
      user_id: userId(),
      phone_number: str('可选手机号'),
    }),
  },
  send_group_ark_share: {
    inputSchema: input({ group_id: groupId() }, ['group_id']),
  },
  share_group_ex: {
    description: 'SnowLuma 旧名；与 send_group_ark_share 同形。',
    inputSchema: input({ group_id: groupId() }, ['group_id']),
  },
  send_tuwen_ark: {
    description: '发送图文 Ark 卡片；user_id 与 group_id 至少给一个。',
    inputSchema: input(
      {
        group_id: groupId(),
        user_id: userId(),
        title: str('卡片标题'),
        desc: str('卡片正文'),
        summary: str('卡片摘要', { default: '[分享]' }),
        preview_url: str('封面图 URL'),
        jump_url: str('点击跳转 URL'),
      },
      ['title', 'desc', 'jump_url'],
    ),
  },
  get_ai_characters: {
    inputSchema: input(
      {
        group_id: groupId(),
        chat_type: int('语音场景类型', { minimum: 0, default: 1 }),
      },
      ['group_id'],
    ),
  },
  get_ai_record: {
    inputSchema: input(
      {
        group_id: groupId(),
        character: str('AI 角色 id'),
        text: str('要合成的文本'),
        chat_type: int('语音场景类型', { minimum: 0, default: 1 }),
      },
      ['group_id', 'character', 'text'],
    ),
  },
  send_group_ai_record: {
    inputSchema: input(
      {
        group_id: groupId(),
        character: str('AI 角色 id'),
        text: str('要合成的文本'),
        chat_type: int('语音场景类型', { minimum: 0, default: 1 }),
      },
      ['group_id', 'character', 'text'],
    ),
  },
  delete_friend: { inputSchema: input({ user_id: userId() }, ['user_id']) },
  set_friend_remark: {
    inputSchema: input({ user_id: userId(), remark: str('好友备注') }, ['user_id', 'remark']),
  },
  get_unidirectional_friend_list: { inputSchema: EMPTY_INPUT },
  get_doubt_friends_add_request: {
    inputSchema: input({ count: int('最多返回条数', { minimum: 1, default: 50 }) }),
  },
  set_doubt_friends_add_request: {
    inputSchema: input(
      { flag: str('申请 flag'), approve: bool('true 同意 / false 拒绝', { default: true }) },
      ['flag'],
    ),
  },

  // ─────────────────────────── 闪传 ───────────────────────────
  create_flash_task: {
    description: 'files 接受路径字符串、{ file, name } 对象，或它们的数组。',
    inputSchema: input(
      {
        files: {
          description: '要闪传的文件：路径 / { file, name } / 数组',
          anyOf: [
            { type: 'string', minLength: 1 },
            { type: 'object', additionalProperties: true },
            {
              type: 'array',
              minItems: 1,
              items: {
                anyOf: [
                  { type: 'string', minLength: 1 },
                  { type: 'object', additionalProperties: true },
                ],
              },
            },
          ],
        },
        name: str('文件集名称'),
        thumb_path: str('缩略图本机路径'),
      },
      ['files'],
    ),
  },
  get_fileset_info: {
    inputSchema: input({ fileset_id: str('闪传文件集 id') }, ['fileset_id']),
  },
  get_flash_file_list: {
    inputSchema: input({ fileset_id: str('闪传文件集 id') }, ['fileset_id']),
  },
  list_filesets: { inputSchema: EMPTY_INPUT },
  list_filesets_page: {
    description: '首屏省略 cursor。续页原样传回 next_cursor，is_end 为 true 时停止。',
    inputSchema: input({
      cursor: str('上一页返回的 Base64 游标', { minLength: 1, maxLength: 4096 }),
      limit: int('每页条数', { minimum: 1, maximum: 100, default: 10 }),
    }),
  },
  get_share_link: {
    inputSchema: input({ fileset_id: str('闪传文件集 id') }, ['fileset_id']),
  },
  delete_flash_file: {
    inputSchema: input({ fileset_id: str('闪传文件集 id') }, ['fileset_id']),
  },
  rename_flash_file: {
    inputSchema: input({ fileset_id: str('闪传文件集 id'), new_name: str('新名称') }, [
      'fileset_id',
      'new_name',
    ]),
  },
  send_flash_msg: {
    description: '把闪传分享发到群或好友；group_id 与 user_id 至少给一个。',
    inputSchema: input(
      { fileset_id: str('闪传文件集 id'), group_id: groupId(), user_id: userId() },
      ['fileset_id'],
    ),
  },
  get_flash_file_url: {
    inputSchema: input(
      {
        fileset_id: str('闪传文件集 id'),
        file_index: int('文件序号，从 1 开始', { minimum: 1, default: 1 }),
      },
      ['fileset_id'],
    ),
  },
  download_fileset: {
    inputSchema: input(
      {
        fileset_id: str('闪传文件集 id'),
        file_index: int('文件序号，从 1 开始', { minimum: 1, default: 1 }),
      },
      ['fileset_id'],
    ),
  },
  get_fileset_id: {
    inputSchema: input({ share_code: str('闪传分享码或分享链接') }, ['share_code']),
  },

  // ─────────────────────────── L2 补充 ───────────────────────────
  get_group_shut_list: { inputSchema: input({ group_id: groupId() }, ['group_id']) },
  fetch_super_face_id: {
    inputSchema: input(
      {
        face_id: faceId('系统表情 face id'),
        refresh: bool('是否刷新服务端缓存', { default: false }),
      },
      ['face_id'],
    ),
  },
  get_group_ignored_notifies: { inputSchema: EMPTY_INPUT },
  get_group_ignore_add_request: { inputSchema: EMPTY_INPUT },
  get_group_share_link: {
    inputSchema: input(
      {
        group_id: groupId(),
        need_short_url: bool('是否生成短链', { default: true }),
        src_id: int('分享来源 id', { minimum: 0, default: 73 }),
        additional_param: str('附加查询参数'),
      },
      ['group_id'],
    ),
  },
  get_rkey_server: { inputSchema: EMPTY_INPUT },
  get_mini_app_ark: {
    inputSchema: input({
      type: enumOf('小程序平台；默认 bili', ['bili', 'weibo']),
      title: str('卡片标题'),
      desc: str('卡片描述'),
      picUrl: str('封面 URL'),
      pic_url: str('封面 URL（picUrl 的别名）'),
      jumpUrl: str('跳转 URL'),
      jump_url: str('跳转 URL（jumpUrl 的别名）'),
    }),
  },
  bot_exit: { inputSchema: EMPTY_INPUT },

  // ─────────────────────────── 账号 / 资料 ───────────────────────────
  get_profile_like: {
    inputSchema: input({
      user_id: int('目标 QQ 号；0 表示自己', { minimum: 0, default: 0 }),
      start: int('分页起点', { minimum: 0, default: 0 }),
      count: int('返回条数', { minimum: 0, default: 10 }),
    }),
  },
  set_qq_profile: {
    description: '只更新传入的字段；sex 接受 0 / 1 / 2。',
    inputSchema: input({
      nickname: str('昵称'),
      personal_note: str('个性签名'),
      sex: { type: 'integer', description: '性别：0 未知 / 1 男 / 2 女', enum: [0, 1, 2] },
    }),
  },
  set_qq_avatar: {
    inputSchema: input({ file: imageSource('头像：base64 / data: / 本机路径') }, ['file']),
  },
  set_online_status: {
    inputSchema: input(
      {
        status: int('主状态码；不能为 0', { not: { const: 0 } }),
        ext_status: int('扩展状态码', { minimum: 0, default: 0 }),
        battery_status: int('电量状态', { minimum: 0, maximum: 100, default: 100 }),
      },
      ['status'],
    ),
  },
  set_diy_online_status: {
    inputSchema: input(
      {
        face_id: faceId('自定义状态图标 id'),
        face_type: int('图标类型', { minimum: 0, default: 1 }),
        wording: str('自定义状态文字'),
      },
      ['face_id'],
    ),
  },
  request_decrypt_key: {
    inputSchema: input({ db_path: str('数据库文件路径') }, ['db_path']),
  },
  get_friends_with_category: {
    inputSchema: input({ with_profile: bool('是否附带好友公开资料') }),
  },
  set_friends_category: {
    description: 'categoryId 与 categoryName 必须且只能给一个；uin 是好友 QQ 号。',
    inputSchema: input(
      {
        uin: userId('好友 QQ 号'),
        categoryId: int('目标分组 id', { minimum: 0 }),
        categoryName: str('目标分组名'),
      },
      ['uin'],
    ),
  },
  set_self_longnick: {
    inputSchema: input({ longNick: str('新个性签名') }, ['longNick']),
  },
  set_input_status: {
    inputSchema: input(
      {
        user_id: userId(),
        event_type: int('输入状态事件类型', { minimum: 0, default: 0 }),
      },
      ['user_id'],
    ),
  },

  // ─────────────────────────── 群侧 web（公告 / 荣誉 / 打卡 / 相册） ───────────────────────────
  _get_group_notice: { inputSchema: input({ group_id: groupId() }, ['group_id']) },
  _send_group_notice: {
    inputSchema: input(
      {
        group_id: groupId(),
        content: str('公告正文'),
        image: imageSource('公告附图'),
        pinned: int('是否置顶', { minimum: 0, default: 0 }),
        type: int('公告类型', { minimum: 0 }),
        send_to_new_members: bool('是否发送给新成员'),
        is_show_edit_card: int('是否显示编辑卡', { minimum: 0 }),
        tip_window_type: int('弹窗提示类型', { minimum: 0 }),
        confirm_required: int('是否需要确认', { minimum: 0 }),
      },
      ['group_id', 'content'],
    ),
  },
  _del_group_notice: {
    description: 'fid 与 notice_id 二选一。',
    inputSchema: input(
      { group_id: groupId(), fid: str('公告 id'), notice_id: str('公告 id（fid 的别名）') },
      ['group_id'],
    ),
  },
  get_group_honor_info: {
    inputSchema: input(
      {
        group_id: groupId(),
        type: {
          description: '荣誉类型；也接受 0/1/2/3/6',
          enum: ['all', 'talkative', 'performer', 'legend', 'emotion', 0, 1, 2, 3, 6],
        },
      },
      ['group_id'],
    ),
  },
  get_group_signed_list: {
    inputSchema: input(
      {
        group_id: groupId(),
        day_ymd: str('日期，格式 YYYYMMDD；默认今天'),
        offset: int('分页偏移', { minimum: 1 }),
        limit: int('返回条数', { minimum: 1 }),
      },
      ['group_id'],
    ),
  },
  get_essence_msg_list: {
    inputSchema: input(
      {
        group_id: groupId(),
        page_start: int('分页起点', { minimum: 1, default: 0 }),
        page_limit: int('每页条数', { minimum: 1, default: 50 }),
      },
      ['group_id'],
    ),
  },
  get_group_album_list: { inputSchema: input({ group_id: groupId() }, ['group_id']) },
  upload_image_to_qun_album: {
    inputSchema: input(
      {
        group_id: groupId(),
        album_id: str('群相册 id'),
        album_name: str('群相册名'),
        file: imageSource('图片：base64 / data: / http(s) URL'),
        file_name: str('文件名'),
      },
      ['group_id', 'album_id', 'album_name', 'file'],
    ),
  },
  get_group_album_media_list: {
    inputSchema: input(
      {
        group_id: groupId(),
        album_id: str('群相册 id'),
        attach_info: str('翻页游标'),
      },
      ['group_id', 'album_id'],
    ),
  },
  do_group_album_comment: {
    inputSchema: input(
      {
        group_id: groupId(),
        album_id: str('群相册 id'),
        lloc: str('媒体定位串'),
        content: str('评论内容'),
        batch_id: str('上传批次 id'),
      },
      ['group_id', 'album_id', 'lloc', 'content'],
    ),
  },
  set_group_album_media_like: {
    inputSchema: input(
      {
        group_id: groupId(),
        album_id: str('群相册 id'),
        batch_id: str('上传批次 id'),
        lloc: str('媒体定位串'),
      },
      ['group_id', 'album_id', 'batch_id'],
    ),
  },
  cancel_group_album_media_like: {
    inputSchema: input(
      {
        group_id: groupId(),
        album_id: str('群相册 id'),
        batch_id: str('上传批次 id'),
        lloc: str('媒体定位串'),
      },
      ['group_id', 'album_id', 'batch_id'],
    ),
  },
  get_qun_album_list: { inputSchema: input({ group_id: groupId() }, ['group_id']) },
  upload_video_to_qun_album: {
    inputSchema: input(
      {
        group_id: groupId(),
        album_id: str('群相册 id'),
        album_name: str('群相册名'),
        file: str('视频：本机路径 / http(s) URL / data:'),
        file_name: str('文件名'),
        cover: imageSource('封面图'),
        duration: int('视频时长（毫秒）', { minimum: 0 }),
        width: int('视频宽度', { minimum: 0 }),
        height: int('视频高度', { minimum: 0 }),
      },
      ['group_id', 'album_id', 'album_name', 'file'],
    ),
  },
  del_group_album_media: {
    inputSchema: input(
      {
        group_id: groupId(),
        album_id: str('群相册 id'),
        lloc: str('媒体定位串'),
        batch_id: str('上传批次 id'),
      },
      ['group_id', 'album_id', 'lloc'],
    ),
  },

  // ─────────────────────────── 账号侧 web ───────────────────────────
  _get_friend_dress: { inputSchema: input({ user_id: userId() }, ['user_id']) },
  get_self_dress: { inputSchema: EMPTY_INPUT },
  get_vip_info: { inputSchema: EMPTY_INPUT },
  get_special_care: { inputSchema: EMPTY_INPUT },
  get_friend_mutual_mark: { inputSchema: input({ user_id: userId() }, ['user_id']) },
  get_dress_mall_rank: {
    inputSchema: input(
      {
        app_id: int('装扮分类：2 气泡 / 4 挂件 / 5 字体', { minimum: 1 }),
        page_index: int('页码，从 1 开始', { minimum: 1, default: 1 }),
        page_size: int('每页条数', { minimum: 1, default: 20 }),
      },
      ['app_id'],
    ),
  },
  search_dress: {
    inputSchema: input(
      {
        app_id: int('装扮分类', { minimum: 1 }),
        keyword: str('搜索关键字'),
        page_index: int('页码，从 0 开始', { minimum: 0, default: 0 }),
        page_size: int('每页条数', { minimum: 1, default: 40 }),
      },
      ['app_id', 'keyword'],
    ),
  },
  get_gift_mall_home: {
    inputSchema: input({ target_uin: userId('收礼人 QQ 号；不传表示自己') }),
  },
  get_gift_mall_list: {
    inputSchema: input({
      target_uin: userId('收礼人 QQ 号；不传表示自己'),
      tab_name: enumOf('顶层页签', ['', '礼品卡', '个性化装扮']),
      sub_tab_name: stringOrArray(
        '子页签，可多选（最近上新 / 鲜花 / 玩偶摆件 / 礼品卡 / 蛋糕 / 主题 / 气泡 / 头像挂件等）',
      ),
      attach_info: str('分页游标，由上一页响应原样传回'),
      batch_num: int('每页条数', { minimum: 1, default: 20 }),
      crowd_tab: str('人群页签'),
    }),
  },
  search_gift_mall: {
    inputSchema: input(
      {
        keyword: str('搜索关键字'),
        target_uin: userId('收礼人 QQ 号；不传表示自己'),
        page_no: int('页码，从 1 开始', { minimum: 1, default: 1 }),
        page_size: int('每页条数', { minimum: 1, default: 20 }),
        attach_info: str('分页游标'),
      },
      ['keyword'],
    ),
  },
  get_gift_mall_gift: {
    inputSchema: input(
      {
        gift_id: str('礼物 id'),
        target_uin: userId('收礼人 QQ 号；不传表示自己'),
      },
      ['gift_id'],
    ),
  },
  get_gift_mall_vip: {
    inputSchema: input({ gift_id: str('礼物 id') }, ['gift_id']),
  },
  get_gift_mall_wall: {
    inputSchema: input(
      {
        is_send: bool('true 送出 / false 收到', { default: true }),
        begin_time: int('服务端返回的 beginTime；首屏传 0（必填）'),
        batch_info: str('服务端游标；翻页时原样传回'),
      },
      ['begin_time'],
    ),
  },
  get_gift_mall_ai_disc_status: { inputSchema: EMPTY_INPUT },
  send_gift: {
    description:
      '赠送礼物。**只下单，不付款**：返回的是支付参数（payMode / url_params 等），真正的支付须在客户端完成。写操作不重试。',
    inputSchema: input(
      {
        gift_id: int('礼物 id', { minimum: 1 }),
        gift_price: int('礼物原价，从列表 / 详情原样传回', { minimum: 1 }),
        svip_discount: int('SVIP 折后价，从列表 / 详情原样传回', { minimum: 1 }),
        to_uin: int('收礼人 QQ 号', { minimum: 1 }),
        message: str('祝福语'),
        need_anonymous: bool('是否匿名', { default: false }),
        buy_num: int('购买数量', { minimum: 1, default: 1 }),
      },
      ['gift_id', 'gift_price', 'svip_discount', 'to_uin'],
    ),
  },

  // ─────────────────────────── 收藏 ───────────────────────────
  get_collection_list: {
    inputSchema: input({
      category: int('收藏分类；0 表示全部', { minimum: 0, default: 0 }),
      count: int('返回条数', { minimum: 1, maximum: 500, default: 50 }),
    }),
  },

  // ─────────────────────────── QQ 空间：读 ───────────────────────────
  get_qzone_profile: {
    inputSchema: input({ target_uin: userId('目标 QQ 号；不传表示自己') }),
  },
  get_qzone_msg_list: {
    inputSchema: input({
      target_uin: userId('目标 QQ 号；不传表示自己'),
      pos: int('分页起点', { minimum: 1, default: 0 }),
      num: int('返回条数', { minimum: 1, default: 20 }),
    }),
  },
  get_qzone_msg_detail: {
    inputSchema: input(
      {
        tid: str('说说 id'),
        target_uin: userId('目标 QQ 号；不传表示自己'),
        pos: int('评论分页起点', { minimum: 0, default: 0 }),
        num: int('评论条数，1-100', { minimum: 1, maximum: 100, default: 20 }),
      },
      ['tid'],
    ),
  },
  get_qzone_feeds: {
    inputSchema: input({
      page_num: int('页码，从 1 开始', { minimum: 1, default: 1 }),
      count: int('每页条数', { minimum: 1, default: 10 }),
      cursor: str('翻页游标'),
    }),
  },
  get_qzone_public_capabilities: { inputSchema: EMPTY_INPUT },
  get_qzone_public_feeds: {
    inputSchema: input({ cursor: str('翻页游标') }),
  },
  get_qzone_public_feed_detail: {
    inputSchema: input({ feed: object('完整动态对象，原样来自列表返回') }, ['feed']),
  },
  get_qzone_public_comments: {
    inputSchema: input(
      {
        feed: object('完整动态对象'),
        cursor: str('评论翻页游标'),
      },
      ['feed', 'cursor'],
    ),
  },
  get_qzone_public_replies: {
    inputSchema: input(
      {
        feed: object('完整动态对象'),
        comment: object('完整父评论对象'),
        cursor: str('回复翻页游标'),
        page_size: int('每页条数', { minimum: 1, default: 20 }),
      },
      ['feed', 'comment'],
    ),
  },

  // ─────────────────────────── QQ 空间：写 ───────────────────────────
  set_qzone_profile: {
    description: '至少提供 name 或 description 之一；未传的字段保持不变。',
    inputSchema: input({
      name: str('空间名称'),
      description: str('空间说明'),
    }),
  },
  send_qzone_msg: {
    inputSchema: input(
      {
        content: str('说说正文'),
        images: arrayOf('图片列表（URL / base64 / 本机路径）', { type: 'string' }),
        ugc_right: int('查看权限', { minimum: 1 }),
        target_uins: arrayOf('可见 / 不可见 QQ 号列表', { type: 'string' }),
      },
      ['content'],
    ),
  },
  delete_qzone_msg: {
    inputSchema: input({ target_uin: userId(), tid: str('说说 id') }, ['tid']),
  },
  like_qzone: {
    inputSchema: input({ target_uin: userId(), tid: str('说说 id') }, ['tid']),
  },
  unlike_qzone: {
    inputSchema: input({ target_uin: userId(), tid: str('说说 id') }, ['tid']),
  },
  comment_qzone: {
    description:
      '只给 content 时发表一级评论；回复评论需成对提供 comment_id / comment_uin，指定接收者时还需成对提供 reply_uin / reply_name。',
    inputSchema: input(
      {
        target_uin: userId(),
        tid: str('说说 id'),
        content: str('评论内容'),
        comment_id: str('父评论 id'),
        comment_uin: str('父评论作者 QQ 号'),
        reply_uin: str('被回复者 QQ 号'),
        reply_name: str('被回复者昵称'),
      },
      ['tid', 'content'],
    ),
  },
  set_qzone_msg_right: {
    description: 'ugc_right 为 16 / 128 时 target_uins 不能为空。',
    inputSchema: input(
      {
        target_uin: userId(),
        tid: str('说说 id'),
        ugc_right: int('查看权限', { minimum: 1, default: 1 }),
        target_uins: arrayOf('权限相关 QQ 号列表', { type: 'string' }),
      },
      ['tid'],
    ),
  },
  set_qzone_ban: {
    inputSchema: input(
      { user_id: userId(), enable: bool('true 拉黑 / false 解除', { default: true }) },
      ['user_id'],
    ),
  },
  forward_qzone_msg: {
    description:
      '转发一条普通说说（emotion_cgi_forward_v6）。转发的是当前这条动态，不带原帖的 t2_tid / fwdtype；reason 为空表示不写转发语。',
    inputSchema: input(
      {
        target_uin: userId('说说作者的 QQ 号；不传表示自己'),
        tid: str('说说 id'),
        reason: str('转发语'),
      },
      ['tid'],
    ),
  },

  // ─────────────────────────── 空友爱看：写 ───────────────────────────
  set_qzone_public_upvote: {
    inputSchema: input(
      { feed: object('完整动态对象'), enable: bool('true 推 / false 取消', { default: true }) },
      ['feed'],
    ),
  },
  set_qzone_public_like: {
    inputSchema: input(
      { feed: object('完整动态对象'), enable: bool('true 点赞 / false 取消', { default: true }) },
      ['feed'],
    ),
  },
  set_qzone_public_comment_like: {
    inputSchema: input(
      {
        feed: object('完整动态对象'),
        comment: object('完整评论对象'),
        reply: optionalObject('要操作的完整回复对象；不传则操作评论'),
        enable: bool('true 点赞 / false 取消', { default: true }),
      },
      ['feed', 'comment'],
    ),
  },
  comment_qzone_public_feed: {
    inputSchema: input({ feed: object('完整动态对象'), content: str('评论内容') }, [
      'feed',
      'content',
    ]),
  },
  reply_qzone_public_feed: {
    inputSchema: input(
      {
        feed: object('完整动态对象'),
        comment: object('完整父评论对象'),
        content: str('回复内容'),
        reply: optionalObject('要回复的完整回复对象'),
      },
      ['feed', 'comment', 'content'],
    ),
  },
  delete_qzone_public_comment: {
    inputSchema: input({ feed: object('完整动态对象'), comment: object('完整评论对象') }, [
      'feed',
      'comment',
    ]),
  },
  delete_qzone_public_reply: {
    inputSchema: input(
      {
        feed: object('完整动态对象'),
        comment: object('完整父评论对象'),
        reply: object('要删除的完整回复对象'),
      },
      ['feed', 'comment', 'reply'],
    ),
  },
  set_qzone_public_follow: {
    inputSchema: input(
      { feed: object('完整动态对象'), enable: bool('true 蹲 / false 取消', { default: true }) },
      ['feed'],
    ),
  },
  forward_qzone_public_feed: {
    inputSchema: input({ feed: object('完整动态对象'), reason: str('转发附言') }, ['feed']),
  },

  // ─────────────────────────── QQ 空间：完整动态 ───────────────────────────
  get_qzone_home_feeds: {
    inputSchema: input({
      target_uin: userId('目标 QQ 号；不传表示自己'),
      cursor: str('翻页游标'),
    }),
  },
  get_qzone_feed_detail: {
    inputSchema: input({ tid: str('说说 id') }, ['tid']),
  },
  get_qzone_share_ark: {
    inputSchema: input({ feed: object('完整动态对象') }, ['feed']),
  },

  // ─────────────────────────── 自定义扩展 ───────────────────────────
  get_dress_url: {
    description:
      '通过 scupdate 按 item_id 换取个性装扮资源地址；气泡 / 挂件会返回各分包的下载链接，字体返回 zip 地址。',
    inputSchema: input(
      {
        type: enumOf('装扮类型：bubble 气泡 / font 字体 / pendant 头像挂件', [
          'bubble',
          'font',
          'pendant',
        ]),
        item_id: int('装扮 itemId', { minimum: 1 }),
      },
      ['type', 'item_id'],
    ),
  },
  ftf2ttf: {
    description:
      '用原生 nt_helper 的字体转换器把 FTF 转成 TTF。输入输出都是本机文件路径，不读内存字节。',
    inputSchema: input(
      {
        file: fileSource('输入 .ftf 字体文件路径'),
        output: str('输出 .ttf 路径；不传时把 .ftf 替换成 .ttf'),
        assets_dir: str('彩色字体资源目录'),
        color: bool('是否生成彩色字形'),
        color_chars: str('参与彩色化的字符集'),
        check_ots: bool('是否跑 OTS 校验（需要本机 ots-sanitize）'),
      },
      ['file'],
    ),
  },
  send_private_flash_photo: {
    description: '给好友发闪照；文件可以是本机路径、http(s) URL 或 base64。',
    inputSchema: input({ user_id: userId(), file: imageSource('闪照图片') }, ['user_id', 'file']),
  },
  send_emoji_bounce: {
    description: '表情弹射：把同一个系统表情弹射多份。group_id 与 user_id 二选一。',
    inputSchema: input(
      {
        group_id: groupId('群号；与 user_id 二选一'),
        user_id: userId('QQ 号；与 group_id 二选一'),
        face_id: int('系统表情 id', { minimum: 0 }),
        count: int('弹射个数', { minimum: 1, default: 10 }),
        name: str('表情名（不带斜杠或方括号）'),
      },
      ['face_id'],
    ),
  },
  send_bubble_msg: {
    description: '发送泡泡消息（圆形循环的短视频，模板名缺省用 video_penguin_dance）。',
    inputSchema: input(
      {
        group_id: groupId('群号；与 user_id 二选一'),
        user_id: userId('QQ 号；与 group_id 二选一'),
        file: fileSource('视频文件路径 / URL / base64'),
        thumb: fileSource('封面图；不传时按宽高合成纯色图'),
        duration: int('时长（秒）', { minimum: 1 }),
        width: int('视频宽度', { minimum: 1 }),
        height: int('视频高度', { minimum: 1 }),
        template_name: str('泡泡模板名'),
      },
      ['file'],
    ),
  },
  get_group_gift_list: {
    description: '拉取群礼物面板，返回页签与每个页签下的礼物条目。',
    inputSchema: input({ group_id: groupId() }, ['group_id']),
  },
  send_location_share: {
    description:
      '发起位置共享并发送位置共享卡片。坐标使用 GCJ-02、经度在前；停止调用 update_location_share 约 60 秒后房间结束。',
    inputSchema: input(
      {
        group_id: groupId('群号；与 user_id 二选一'),
        user_id: userId('QQ 号；与 group_id 二选一'),
        longitude: { type: 'number', description: '经度（GCJ-02）' },
        latitude: { type: 'number', description: '纬度（GCJ-02）' },
        interval: int('期望的上报间隔（秒）', { minimum: 1, default: 2 }),
      },
      ['longitude', 'latitude'],
    ),
  },
  update_location_share: {
    description: '更新位置共享里的当前定位；需要按服务端返回的 interval 持续调用。',
    inputSchema: input(
      {
        group_id: groupId('群号；与 user_id 二选一'),
        user_id: userId('QQ 号；与 group_id 二选一'),
        longitude: { type: 'number', description: '经度（GCJ-02）' },
        latitude: { type: 'number', description: '纬度（GCJ-02）' },
        extra: { type: 'number', description: '抓包里语义未确认的附加数值；缺省 0' },
      },
      ['longitude', 'latitude'],
    ),
  },
  get_qq_show_url: {
    description: '获取 QQ 秀图片地址；不传 user_id 时查自己，没有 QQ 秀时 url 为空。',
    inputSchema: input({ user_id: userId('目标 QQ 号；不传表示自己') }),
  },
};

/** 取某条 action 的元数据；未登记时返回 undefined（由调用方回退到 summary）。 */
export function actionMetadata(name: string): ActionMetadata | undefined {
  return ACTION_METADATA[name];
}
