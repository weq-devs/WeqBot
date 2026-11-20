/**
 * 群通话的媒体帧（`0x17` 上行 / `0x18` 下行）。
 *
 * 与私聊 `call/video.ts` 的 `0x5b` 完全不同：群聊的媒体载荷也塞在 `0x02` 通道里，
 * 外层包头（17 字节）之后是一段**变长的媒体头**，`body[16]` 的 track 类型决定它
 * 是音频还是视频。
 *
 * ```text
 * body[0:7]    流标识（`18 57 06 aa XX XX 00`，每成员不同）
 * body[7]      0x01（c2s）/ 0x02（s2c）—— 方向
 * body[8]      0xa7（音频）/ 0x83（视频）
 * body[9:14]   包序号（5B，逐包递增）
 * body[14]     音频 0x79 / 视频 0x83
 * body[15]     音频 0xa7（c2s）/ 0x05（s2c）；视频 0xa7
 * body[16]     **track 类型**：1 = 音频，2 = 视频，3 = 视频（另一路编码）
 * body[17]     音频 0x01；视频 0x07 / 0x01 / 0x00
 * body[18]     音频 **分片标记**（0x00 = 媒体数据，0x10 = 成员信息包，
 *              0x50 = 带 FEC）；视频 **分片序号 pkgIdx**
 * ```
 *
 * ## 音频载荷定位（2026-11-05 用 `nt_helper.decodeCallFrame` 逐包验证）
 *
 * `body[20]` 的 bit7 决定长度字段的位置：
 *
 * ```text
 * body[20] & 0x80 == 0  → 长度在 body[30]，载荷从 body[32] 开始
 * body[20] & 0x80 != 0  → 长度在 body[35]，载荷从 body[37] 开始
 * ```
 *
 * 长度三元组是 `L | (L-2) & 0xff | 00`，`L` 就是 Opus 载荷的字节数，载荷是紧跟在
 * 长度字段之后的 `L` 字节（起点 = 长度字段 + 2，首字节是 Opus TOC 0x00 = SILK
 * 窄带 10 ms）。两种形态合起来对三份抓包的解码率是 100%（159/159、135/135），
 * 解码出的都是真实语音（平均振幅 7000+）。
 *
 * > ⚠️ 早期版本把载荷起点固定成 `b[19]`，后来又试过 `b[33]`，都只能解出一部分包。
 * > 真正的分界是 `body[20]` 的 bit7，别再用固定偏移。
 * >
 * > 长度三元组同时是**成员信息包**的排除条件：那类包（`body[18] = 0x10`，
 * > 36 字节）的 `body[30] = 0x04`、`body[31] = 0x00`，不满足 `L-2` 校验，会被丢掉。
 *
 * ## H.264 分片（track 2）
 *
 * `body[18]` 是片号，`body[19]` 是数据片数，`body[20]` 是冗余片数。
 * `body[22]` 是帧号，`body[30:32]` 是小端片计数。Annex B 首片从 35 取，续片从 32 取。
 * 冗余片位于数据片之后。接收端在数据片齐全时可以直接输出 H.264。
 *
 * ## 没有 P2P
 *
 * 群聊全部媒体都走服务器中继，`0x02` 包头的 `[13:17]` 指明谁发的流。
 */

import { u16be, u32be, writeU32be } from '../call/gcs';

// ─────────────────────────── 常量 ───────────────────────────

/** `body[16]`：track 类型的位置。 */
const TRACK_OFFSET = 16;
/** 音频长度字段的两种位置，由 `body[20]` 的 bit7 决定。 */
const AUDIO_LEN_OFFSET_PLAIN = 30;
const AUDIO_LEN_OFFSET_EXT = 35;
/**
 * 载荷起点相对长度字段的偏移。
 *
 * 实测载荷就是紧跟在 `L | (L-2) | 00` 之后的那 `L` 个字节，其中第一个字节是
 * Opus TOC（0x00 = SILK 窄带 10 ms 单声道），所以起点是 `长度字段 + 2`。
 */
const AUDIO_PAYLOAD_DELTA = 2;
const VIDEO_FIRST_PAYLOAD_OFFSET = 35;
const VIDEO_CONTINUATION_OFFSET = 32;
const VIDEO_FRAME_OFFSET = 22;
const VIDEO_FEC_OFFSET = 20;
/** 视频分片头里 pkgIdx 的位置。 */
const VIDEO_IDX_OFFSET = 18;
/** 视频分片头里总分片数的位置（`body[19]`）。 */
const VIDEO_TOTAL_OFFSET = 19;

/** 媒体包里的 track 类型（`body[16]`）。 */
export const GroupTrack = {
  /** 音频（Opus）。 */
  audio: 1,
  /** 视频（H.264）。 */
  video: 2,
  /** 另一路上行视频，载荷格式待确认。 */
  videoAlt: 3,
} as const;

/** 音频分片标记（`body[18]`）。 */
export const GroupAudioFragmentFlag = {
  /** 媒体数据。 */
  media: 0x00,
  /** 成员信息包（36 字节，不是音频载荷）。 */
  memberInfo: 0x10,
  /** 带 FEC 冗余的媒体数据。 */
  fec: 0x50,
} as const;

/** H.264 Annex B 起始码。 */
export const H264_START_CODE = Uint8Array.from([0x00, 0x00, 0x00, 0x01]);

// ─────────────────────────── 解析 ───────────────────────────

/** 解析后的媒体头（`0x17` / `0x18` 共用）。 */
export interface GroupMediaHeader {
  /** `body[0:7]` 流标识。 */
  stream: Uint8Array;
  /** `body[7]`：0x01 = c2s，0x02 = s2c。 */
  direction: number;
  /** `body[8]`：0xa7（音频）/ 0x83（视频）。 */
  codec: number;
  /** `body[9:14]` 的包序号（5B 大端）。 */
  seq: number;
  /** `body[16]`：track 类型，见 {@link GroupTrack}。 */
  track: number;
}

/** 解析媒体头；track 类型不认识时返回 `null`。 */
export function parseGroupMediaHeader(body: Uint8Array): GroupMediaHeader | null {
  if (body.length < TRACK_OFFSET + 1) return null;
  const track = body[TRACK_OFFSET]!;
  if (track !== GroupTrack.audio && track !== GroupTrack.video && track !== GroupTrack.videoAlt) {
    return null;
  }
  return {
    stream: body.subarray(0, 7),
    direction: body[7]!,
    codec: body[8]!,
    seq: readSeq5(body, 9),
    track,
  };
}

/** 解析后的音频帧。 */
export interface GroupAudioFrame {
  /** 分片标记（`body[18]`），见 {@link GroupAudioFragmentFlag}。 */
  fragmentFlag: number;
  /** Opus 载荷（已按长度字段切好）。 */
  payload: Uint8Array;
  /** 长度字段里声明的载荷长度（= `payload.length`）。 */
  declaredLength: number;
  /** 完整 body，调试用。 */
  raw: Uint8Array;
}

/**
 * 从音频 body 里切出 Opus 载荷。
 *
 * 长度字段位置由 `body[20]` 的 bit7 决定（见模块注释），载荷长度就是字段值本身。
 * 三元组校验不过时返回 `null` —— 这类包是成员信息包（`body[18] = 0x10`），
 * 不是音频。
 */
export function parseGroupAudioFrame(body: Uint8Array): GroupAudioFrame | null {
  const lenOffset = (body[20] ?? 0) & 0x80 ? AUDIO_LEN_OFFSET_EXT : AUDIO_LEN_OFFSET_PLAIN;
  if (body.length < lenOffset + 3) return null;

  const declaredLength = body[lenOffset]!;
  if (declaredLength < 3) return null;
  // 冗余校验：后一字节恒为 L-2，再后一字节恒为 0。
  if (body[lenOffset + 1] !== ((declaredLength - 2) & 0xff)) return null;
  if (body[lenOffset + 2] !== 0x00) return null;

  const start = lenOffset + AUDIO_PAYLOAD_DELTA;
  const end = start + declaredLength;
  if (end > body.length) return null;

  return {
    fragmentFlag: body[18] ?? 0,
    payload: body.subarray(start, end),
    declaredLength,
    raw: body,
  };
}

/** 一个 track 2 数据片。 */
export interface GroupVideoFragment {
  stream: Uint8Array;
  frameIndex: number;
  firstPacketIndex: number;
  pkgIdx: number;
  /** 原始数据片数。 */
  totalPkg: number;
  fecPackets: number;
  payload: Uint8Array;
  raw: Uint8Array;
}

export function parseGroupVideoFragment(body: Uint8Array): GroupVideoFragment | null {
  if (body[TRACK_OFFSET] !== GroupTrack.video || body.length <= VIDEO_CONTINUATION_OFFSET)
    return null;
  const pkgIdx = body[VIDEO_IDX_OFFSET]!;
  const totalPkg = body[VIDEO_TOTAL_OFFSET]!;
  const start = pkgIdx === 0 ? VIDEO_FIRST_PAYLOAD_OFFSET : VIDEO_CONTINUATION_OFFSET;
  if (pkgIdx >= totalPkg || body.length <= start) return null;
  const payload = body.subarray(start);
  if (pkgIdx === 0 && !H264_START_CODE.every((byte, i) => byte === payload[i])) return null;
  return {
    stream: body.subarray(0, 7),
    frameIndex: body[VIDEO_FRAME_OFFSET]!,
    firstPacketIndex: ((body[30]! | (body[31]! << 8)) - pkgIdx) & 0xffff,
    pkgIdx,
    totalPkg,
    fecPackets: body[VIDEO_FEC_OFFSET]!,
    payload,
    raw: body,
  };
}

export interface GroupVideoFrame {
  data: Uint8Array;
  keyframe: boolean;
  fragments: number;
  ownerUin: number;
}

interface PendingVideoFrame {
  total: number;
  chunks: Map<number, Uint8Array>;
  emitted: boolean;
}

interface GroupVideoStream {
  frames: Map<string, PendingVideoFrame>;
  parameterSets: number;
}

/** 按成员和流维护解码起点，按帧号与首片计数处理乱序和重复。 */
export class GroupVideoAssembler {
  private readonly pending = new Map<number, Map<string, GroupVideoStream>>();

  push(ownerUin: number, fragment: GroupVideoFragment): GroupVideoFrame | null {
    const { stream, frameIndex, firstPacketIndex, pkgIdx, payload, totalPkg } = fragment;
    const streamId = stream.join(',');
    let streams = this.pending.get(ownerUin);
    if (!streams) {
      streams = new Map();
      this.pending.set(ownerUin, streams);
    }
    let video = streams.get(streamId);
    if (!video) {
      if (streams.size >= 4) streams.delete(streams.keys().next().value!);
      video = { frames: new Map(), parameterSets: 0 };
      streams.set(streamId, video);
    }

    const frameId = `${frameIndex}:${firstPacketIndex}`;
    let frame = video.frames.get(frameId);
    if (!frame) {
      if (video.frames.size >= 4) video.frames.delete(video.frames.keys().next().value!);
      frame = { total: totalPkg, chunks: new Map(), emitted: false };
      video.frames.set(frameId, frame);
    }
    if (frame.emitted || frame.total !== totalPkg || pkgIdx >= totalPkg) return null;
    frame.chunks.set(pkgIdx, payload);
    if (frame.chunks.size !== totalPkg) return null;

    const chunks = Array.from({ length: totalPkg }, (_, index) => frame.chunks.get(index)!);
    const data = concat(chunks);
    frame.emitted = true;
    frame.chunks.clear();

    const types = h264NalTypes(data);
    video.parameterSets |= types & H264_PARAMETER_SETS;
    // 参数集可能分两帧送达，提前转交给解码器。
    if (!(types & H264_PARAMETER_SETS) && video.parameterSets !== H264_PARAMETER_SETS) return null;
    return {
      data,
      keyframe: (types & ((1 << 5) | (1 << 7))) !== 0,
      fragments: totalPkg,
      ownerUin,
    };
  }

  reset(ownerUin?: number): void {
    if (ownerUin === undefined) this.pending.clear();
    else this.pending.delete(ownerUin);
  }
}

const H264_PARAMETER_SETS = (1 << 7) | (1 << 8);

/** Annex B 已带 IDR 或 SPS。 */
export function hasIdrNal(data: Uint8Array): boolean {
  return (h264NalTypes(data) & ((1 << 5) | (1 << 7))) !== 0;
}

function h264NalTypes(data: Uint8Array): number {
  let types = 0;
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) continue;
    types |= 1 << (data[i + 3]! & 0x1f);
    i += 2;
  }
  return types;
}

// ─────────────────────────── 组包 ───────────────────────────

/**
 * 组一个音频上行包（`0x17`）。
 *
 * 只做「媒体数据」这一种形态（`body[18] = 0x00`）；带 FEC 的形态（`0x50`）留给
 * 后续补冗余时再扩。
 *
 * 字段取自 ③ 的真实上行包，其中：
 * - `frameIndex`（`body[24]`）每帧 +1
 * - `sampleTs`（`body[25:29]`）每 20 ms 帧 +320 采样
 *
 * 其余字节是三份抓包里恒定的占位，**换 QQ 版本后要重新核对**。
 */
export function buildGroupAudioFrame(params: {
  route: number;
  ownerUin: number;
  stream: Uint8Array;
  seq: number;
  frameIndex: number;
  sampleTs: number;
  opus: Uint8Array;
}): Uint8Array {
  assertStream(params.stream);
  const len = params.opus.length;
  if (len < 3 || len > 0xfe) throw new RangeError(`Opus 帧长度不合法：${len}`);

  const body = new Uint8Array(AUDIO_LEN_OFFSET_PLAIN + AUDIO_PAYLOAD_DELTA + len);
  body.set(params.stream, 0);
  body[7] = 0x01; // c2s
  body[8] = 0xa7;
  writeSeq5(body, 9, params.seq);
  body[14] = 0x79;
  body[15] = 0xa7;
  body[16] = GroupTrack.audio;
  body[17] = 0x01;
  body[18] = GroupAudioFragmentFlag.media;
  body[19] = 0x03;
  body[20] = 0x3e; // bit7 = 0 → 长度字段在 30
  body[21] = 0x01;
  body[22] = 0x25;
  body[23] = 0x00;
  body[24] = params.frameIndex & 0xff;
  writeU32be(body, 25, params.sampleTs >>> 0);
  body[29] = 0x00;
  body[AUDIO_LEN_OFFSET_PLAIN] = len;
  body[AUDIO_LEN_OFFSET_PLAIN + 1] = (len - 2) & 0xff;
  body[AUDIO_LEN_OFFSET_PLAIN + 2] = 0x00;
  body.set(params.opus, AUDIO_LEN_OFFSET_PLAIN + AUDIO_PAYLOAD_DELTA);

  return wrapMedia(params.route, params.ownerUin, body);
}

/**
 * 把一个 H.264 帧切成若干个视频分片（`0x17`）。
 *
 * 分片上限默认 1000 字节：抓包里单包载荷最大约 1100，留一点余量避免超过 MTU 太多。
 */
export function buildGroupVideoFragments(params: {
  route: number;
  ownerUin: number;
  stream: Uint8Array;
  seq: number;
  /** Annex B 裸流。 */
  data: Uint8Array;
  /** 每片载荷上限。 */
  maxPayload?: number;
  /** 同一帧内固定，逐帧递增。 */
  frameIndex?: number;
  /** 视频分片计数。 */
  packetIndex?: number;
  /** 本帧是否关键帧。 */
  keyframe?: boolean;
}): Uint8Array[] {
  assertStream(params.stream);
  const maxPayload = params.maxPayload ?? 1000;
  if (!Number.isInteger(maxPayload) || maxPayload < 16) throw new RangeError('分片上限太小');

  if (params.data.length === 0) return [];
  const total = Math.ceil(params.data.length / maxPayload);
  if (total > 0xff) throw new RangeError(`分片数超过 255：${total}`);

  const out: Uint8Array[] = [];
  let cursor = 0;
  // 第一片包含 3 个额外头字节。无冗余上行样本的分片使用接近相等的大小。
  const continuationSize = Math.ceil((params.data.length + 3) / total);
  for (let idx = 0; idx < total; idx++) {
    const headerSize = idx === 0 ? VIDEO_FIRST_PAYLOAD_OFFSET : VIDEO_CONTINUATION_OFFSET;
    const minimum = params.data.length - cursor - maxPayload * (total - idx - 1);
    const size = Math.max(minimum, Math.min(maxPayload, continuationSize - (idx === 0 ? 3 : 0)));
    const chunk = params.data.subarray(cursor, cursor + size);
    cursor += chunk.length;
    const body = new Uint8Array(headerSize + chunk.length);
    // 字段布局按 698 个真实上行视频包统计得出（见文件头注释）。
    body.set(params.stream, 0);
    body[7] = 0x01; // c2s
    body[8] = 0xa7; // codec 标记
    body[9] = 0x83; // 视频标记
    // 序号是 4 字节（[10:14]），不是 5 字节。
    writeU32be(body, 10, (params.seq + idx) >>> 0);
    body[14] = 0x83;
    body[15] = 0xa7;
    body[16] = GroupTrack.video;
    body[17] = params.keyframe ? 0x00 : 0x07;
    body[18] = idx;
    body[19] = total; // 本帧总分片数
    body[20] = 0x00;
    body[21] = 0x0c;
    body[22] = (params.frameIndex ?? 0) & 0xff;
    body[23] = 0x01;
    body[24] = 0x04;
    body[25] = 0x04;
    body[26] = 0x02;
    body[28] = 0x04;
    body[29] = 0x08;
    const packetIndex = (params.packetIndex ?? params.seq) + idx;
    body[30] = packetIndex & 0xff;
    body[31] = (packetIndex >>> 8) & 0xff;
    if (idx === 0) {
      body[34] = 0x03;
    }
    body.set(chunk, headerSize);
    out.push(wrapMedia((params.route + idx) & 0xffffff, params.ownerUin, body));
  }
  return out;
}

// ─────────────────────────── 小工具 ───────────────────────────

/** 读 5 字节大端序号。 */
export function readSeq5(buf: Uint8Array, off: number): number {
  return u32be(buf, off) * 256 + buf[off + 4]!;
}

function writeSeq5(buf: Uint8Array, off: number, value: number): void {
  buf[off] = Math.floor(value / 0x100000000) & 0xff;
  writeU32be(buf, off + 1, value >>> 0);
}

/** 把媒体 body 包进 `0x02` 外层（`kind = 0x04`、`cmd = 0x17`）。 */
function wrapMedia(route: number, ownerUin: number, body: Uint8Array): Uint8Array {
  const total = 17 + body.length + 1;
  if (total > 0xffff) throw new RangeError(`群通话媒体包超过 65535 字节：${total}`);
  const out = new Uint8Array(total);
  out[0] = 0x02;
  out[1] = (total >>> 8) & 0xff;
  out[2] = total & 0xff;
  // 上行媒体的 kind 实测是 **0x00**（不是 0x04）。
  // 抓包统计：c2s `0x17` 全部 kind=0x00（920 包），s2c `0x18` 是 0x03（1051 包）。
  // 之前写 0x04 会让服务端/对端把我们的媒体包当未知类型丢掉。
  out[3] = 0x00;
  out[4] = (route >>> 16) & 0xff;
  out[5] = (route >>> 8) & 0xff;
  out[6] = route & 0xff;
  out[7] = 0x00;
  out[8] = 0x17;
  writeU32be(out, 13, ownerUin);
  out.set(body, 17);
  out[out.length - 1] = 0x03;
  return out;
}

function assertStream(stream: Uint8Array): void {
  if (stream.length !== 7) throw new RangeError(`流标识必须是 7 字节，收到 ${stream.length}`);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

/** 媒体包是否是 `0x17` / `0x18`。 */
export function isGroupMediaCmd(cmd: number): boolean {
  return cmd === 0x17 || cmd === 0x18;
}

/** 媒体包的 `[1:3]` 长度字段（导出给测试用）。 */
export function mediaPacketLength(data: Uint8Array): number {
  return u16be(data, 1);
}
