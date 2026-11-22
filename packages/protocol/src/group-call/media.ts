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
 * body[8]      媒体标记（旧档 0xa7，新档 0xfa）
 * body[9:15]   音频为两个低 24 位毫秒时钟，视频为标志及两个低 16 位毫秒时钟
 * body[16]     **track 类型**：1 = 音频，2 = 视频，3 = 视频（另一路编码）
 * body[17]     音频 0x01；视频 0x07 / 0x01 / 0x00
 * body[18]     音频 **分片标记**（0x00 = 媒体数据，0x10 = 成员信息包，
 *              0x50 = 带 FEC）；视频 **分片序号 pkgIdx**
 * ```
 *
 * ## SILK 音频
 *
 * 普通头的 16 位帧号和 32 位采样时钟从 body[23] 和 body[25] 读取。
 * 扩展头（body[20] 的 bit7）在帧号前插入一个字节，采样时钟后另有 5 字节扩展。
 * 两种头的长度字段分别在 body[30] 和 body[35]。长度三元组为
 * `(SILK 长度 + 2) | SILK 长度 | 00`，随后是裸 SILK 和两个结束字节。
 * 带外 FEC 包在首个音频帧后还有冗余数据。
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
const AUDIO_LENGTH_HEADER = 3;
const AUDIO_TRAILER_LENGTH = 2;
const AUDIO_FRAME_OFFSET = 23;
const AUDIO_EXTENSION_INTERVAL = 15;
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
  /** 音频（SILK）。 */
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
  /** 媒体头里的 5 字节原始值。音频帧号由 parseGroupAudioFrame 读取。 */
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
  /** 分片标记，见 {@link GroupAudioFragmentFlag}。 */
  fragmentFlag: number;
  frameIndex: number;
  sampleTs: number;
  /** 首个音频帧的裸 SILK 数据。 */
  payload: Uint8Array;
  declaredLength: number;
  raw: Uint8Array;
}

export function parseGroupAudioFrame(body: Uint8Array): GroupAudioFrame | null {
  if (body[TRACK_OFFSET] !== GroupTrack.audio) return null;
  const fragmentFlag = body[18];
  if (fragmentFlag !== GroupAudioFragmentFlag.media && fragmentFlag !== GroupAudioFragmentFlag.fec)
    return null;
  const extended = Boolean((body[20] ?? 0) & 0x80);
  const lengthOffset = extended ? AUDIO_LEN_OFFSET_EXT : AUDIO_LEN_OFFSET_PLAIN;
  const declaredLength = body[lengthOffset] ?? 0;
  const silkLength = declaredLength - AUDIO_TRAILER_LENGTH;
  const start = lengthOffset + AUDIO_LENGTH_HEADER;
  const end = start + silkLength;
  if (
    silkLength <= 0 ||
    end + AUDIO_TRAILER_LENGTH > body.length ||
    body[lengthOffset + 1] !== silkLength ||
    body[lengthOffset + 2] !== 0
  )
    return null;
  const frameOffset = AUDIO_FRAME_OFFSET + Number(extended);
  return {
    fragmentFlag,
    frameIndex: u16be(body, frameOffset),
    sampleTs: u32be(body, frameOffset + 2),
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

/** 组一个 SILK 音频上行包（`0x17`）。扩展头每 15 帧发送一次。 */
export function buildGroupAudioFrame(params: {
  route: number;
  ownerUin: number;
  stream: Uint8Array;
  sentAt: number;
  capturedAt: number;
  frameIndex: number;
  sampleTs: number;
  silk: Uint8Array;
  profile?: number;
}): Uint8Array {
  assertStream(params.stream);
  const len = params.silk.length;
  if (len === 0 || len + AUDIO_TRAILER_LENGTH > 0xff) {
    throw new RangeError(`SILK 帧长度不合法：${len}`);
  }

  const extended = (params.frameIndex - 1) % AUDIO_EXTENSION_INTERVAL === 0;
  const lengthOffset = extended ? AUDIO_LEN_OFFSET_EXT : AUDIO_LEN_OFFSET_PLAIN;
  const body = new Uint8Array(lengthOffset + AUDIO_LENGTH_HEADER + len + AUDIO_TRAILER_LENGTH);
  body.set(params.stream);
  const legacy = params.profile !== undefined && params.profile < 10065;
  const marker = legacy ? 0xa7 : 0xfa;
  body[7] = 1;
  body[8] = body[15] = marker;
  body[9] = (params.sentAt >>> 16) & 0xff;
  body[10] = (params.sentAt >>> 8) & 0xff;
  body[11] = params.sentAt & 0xff;
  body[12] = params.capturedAt & 0xff;
  body[13] = (params.capturedAt >>> 8) & 0xff;
  body[14] = (params.capturedAt >>> 16) & 0xff;
  body.set([GroupTrack.audio, 1, 0, 3, extended ? 0xbe : 0x3e, 1], 16);
  if (extended) body[22] = 1;
  const frameOffset = AUDIO_FRAME_OFFSET + Number(extended);
  body[frameOffset - 1] = 0x25;
  body[frameOffset] = (params.frameIndex >>> 8) & 0xff;
  body[frameOffset + 1] = params.frameIndex & 0xff;
  writeU32be(body, frameOffset + 2, params.sampleTs >>> 0);
  if (extended) body.set([0x10, 0x01], 30);
  body[lengthOffset] = len + AUDIO_TRAILER_LENGTH;
  body[lengthOffset + 1] = len;
  body.set(params.silk, lengthOffset + AUDIO_LENGTH_HEADER);
  return wrapMedia(params.route, params.ownerUin, body);
}

/**
 * 群视频发送使用两个低 16 位毫秒时钟。分片按 wire 长度对齐，校验片从续片载荷
 * 偏移开始异或，包含首片附带的三个字节。
 */
export function buildGroupVideoFragments(params: {
  route: number;
  ownerUin: number;
  stream: Uint8Array;
  /** 供直接调用者提供时钟。会话会显式传发送与采集时间。 */
  seq: number;
  sentAt?: number;
  capturedAt?: number;
  data: Uint8Array;
  maxPayload?: number;
  frameIndex?: number;
  packetIndex?: number;
  keyframe?: boolean;
  /** 与本场 QQ 信令能力档匹配的媒体头。 */
  profile?: number;
  /** 低分辨率的第二路 H.264 使用短头。 */
  secondary?: boolean;
  /** 与关键帧同一组的流标记。 */
  groupIndex?: number;
}): Uint8Array[] {
  assertStream(params.stream);
  const maxPayload = params.maxPayload ?? 960;
  if (!Number.isInteger(maxPayload) || maxPayload < 16) throw new RangeError('分片上限太小');
  if (params.data.length === 0) return [];

  const continuationOffset = params.secondary ? 24 : VIDEO_CONTINUATION_OFFSET;
  const total = Math.ceil((params.data.length + 3) / maxPayload);
  const parityCount = total > 1 ? 1 : 0;
  if (total + parityCount > 0xff) throw new RangeError(`分片数超过 255：${total + parityCount}`);

  const shardSize = Math.ceil((params.data.length + 3) / total);
  const shards: Uint8Array[] = [];
  const frameIndex = params.frameIndex ?? 0;
  const payload = new Uint8Array(total * shardSize);
  const extensionIndex = params.keyframe ? 0 : (frameIndex - 1) & 0xffff;
  payload.set([extensionIndex & 0xff, extensionIndex >>> 8, 0x03]);
  payload.set(params.data, 3);
  const parity = new Uint8Array(shardSize);
  for (let index = 0; index < total; index++) {
    const shard = payload.subarray(index * shardSize, (index + 1) * shardSize);
    shards.push(shard);
    if (parityCount) {
      for (let byte = 0; byte < shardSize; byte++) parity[byte] = parity[byte]! ^ shard[byte]!;
    }
  }
  if (parityCount) shards.push(parity);

  const legacy = params.profile !== undefined && params.profile < 10065;
  const marker = legacy ? 0xa7 : 0xfa;
  const codec = legacy ? 0x83 : 0x80;
  const sendTick = params.sentAt ?? params.seq;
  const frameTick = params.capturedAt ?? sendTick;
  return shards.map((shard, index) => {
    const body = new Uint8Array(continuationOffset + shard.length);
    body.set(params.stream);
    body[7] = 0x01;
    body[8] = body[15] = marker;
    body[9] = body[14] = codec;
    body[10] = (sendTick >>> 8) & 0xff;
    body[11] = sendTick & 0xff;
    body[12] = frameTick & 0xff;
    body[13] = (frameTick >>> 8) & 0xff;
    body[16] = params.secondary ? GroupTrack.videoAlt : GroupTrack.video;
    body[17] = params.keyframe ? 0 : params.secondary ? 2 : 7;
    body[18] = index;
    body[19] = total;
    body[20] = parityCount;
    body[22] = params.secondary && params.keyframe ? 0 : frameIndex & 0xff;
    body[23] = (params.groupIndex ?? 1) & 0xff;
    if (!params.secondary) {
      body.set([0x0c, body[22]!, body[23]!, 4, 4, 2, 0, 4, 8], 21);
      const packetIndex = (params.packetIndex ?? params.seq) + index;
      body[30] = packetIndex & 0xff;
      body[31] = (packetIndex >>> 8) & 0xff;
    }
    body.set(shard, continuationOffset);
    return wrapMedia((params.route + index) & 0xffffff, params.ownerUin, body);
  });
}

// ─────────────────────────── 小工具 ───────────────────────────

/** 读 5 字节大端序号。 */
export function readSeq5(buf: Uint8Array, off: number): number {
  return u32be(buf, off) * 256 + buf[off + 4]!;
}

/** 把媒体 body 包进 `0x02` 上行外层（`kind = 0x00`、`cmd = 0x17`）。 */
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
