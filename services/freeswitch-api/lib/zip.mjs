// 最小 ZIP 读写（store / deflate 两种方式）。
//
// 为什么不引第三方库：便携版是把 node + 代码一起打包分发的，
// 新增 npm 依赖意味着要同步改打包流程并在每台机器上带一份 node_modules。
// 备份场景只需要「打包若干文件」和「解出若干文件」这两种最基本的能力，
// 内建实现足够，且不增加分发体积。
//
// 刻意不支持的：ZIP64（单文件 / 总大小需 < 4GB，备份场景远达不到）、
// 加密、分卷、注释、符号链接。遇到这些会明确报错而不是静默出错。

import { deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;

// UTF-8 文件名标志位（通用目的标志 bit 11）
const FLAG_UTF8 = 0x0800;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

/** DOS 时间/日期（ZIP 用的老格式，1980 年起算）。 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * 打包若干文件。
 * @param {Array<{ name: string, data: Buffer }>} entries 文件名需为相对路径（用 / 分隔）
 * @returns {Buffer} 完整 ZIP 内容
 */
export function createZip(entries, { compress = true } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw Object.assign(new Error("ZIP 至少需要包含一个文件"), { status: 400 });
  }
  if (entries.length > 0xffff) {
    throw Object.assign(new Error("文件数量超出 ZIP 上限"), { status: 400 });
  }

  const now = dosDateTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = String(entry?.name ?? "");
    if (!name) throw Object.assign(new Error("ZIP 条目缺少文件名"), { status: 400 });
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "");
    const nameBuffer = Buffer.from(name, "utf8");

    // 音频本身已是压缩格式，再 deflate 收益很小但耗时明显；
    // 由调用方决定是否压缩。这里仅在压缩后确实更小时才采用。
    const deflated = compress ? deflateRawSync(raw, { level: 6 }) : null;
    const useDeflate = deflated !== null && deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);            // 解压所需版本 2.0
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);            // extra 长度
    nameBuffer.copy(local, 30);
    locals.push(local, payload);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);          // 创建版本
    central.writeUInt16LE(20, 6);          // 解压所需版本
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(now.time, 12);
    central.writeUInt16LE(now.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);          // extra
    central.writeUInt16LE(0, 32);          // comment
    central.writeUInt16LE(0, 34);          // 起始磁盘
    central.writeUInt16LE(0, 36);          // 内部属性
    central.writeUInt32LE(0, 38);          // 外部属性
    central.writeUInt32LE(offset, 42);     // 对应 local header 偏移
    nameBuffer.copy(central, 46);
    centrals.push(central);

    offset += local.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(EOCD_MIN_LENGTH);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);                // 当前磁盘号
  eocd.writeUInt16LE(0, 6);                // 中央目录起始磁盘
  eocd.writeUInt16LE(entries.length, 8);   // 本磁盘条目数
  eocd.writeUInt16LE(entries.length, 10);  // 总条目数
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);               // 注释长度

  return Buffer.concat([...locals, centralBuffer, eocd]);
}

/** 从末尾向前找 EOCD（末尾可能有注释，但本实现写出的包没有）。 */
function findEndOfCentralDirectory(buffer) {
  const minStart = Math.max(0, buffer.length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH);
  for (let index = buffer.length - EOCD_MIN_LENGTH; index >= minStart; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD_SIGNATURE) return index;
  }
  return -1;
}

/**
 * 解出 ZIP 内所有文件。
 * @returns {Map<string, Buffer>} 文件名 → 内容
 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < EOCD_MIN_LENGTH) {
    throw Object.assign(new Error("备份文件不是有效的 ZIP"), { status: 400 });
  }
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    throw Object.assign(new Error("备份文件已损坏：找不到 ZIP 结尾标记"), { status: 400 });
  }

  const total = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (centralOffset + centralSize > buffer.length) {
    throw Object.assign(new Error("备份文件已损坏：中央目录越界"), { status: 400 });
  }

  const files = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw Object.assign(new Error("备份文件已损坏：中央目录记录异常"), { status: 400 });
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw Object.assign(new Error(`备份文件已损坏：${name} 的头部异常`), { status: 400 });
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      throw Object.assign(new Error(`备份文件已损坏：${name} 数据越界`), { status: 400 });
    }
    const payload = buffer.subarray(dataStart, dataEnd);

    if (method === METHOD_STORE) files.set(name, Buffer.from(payload));
    else if (method === METHOD_DEFLATE) files.set(name, inflateRawSync(payload));
    else throw Object.assign(new Error(`不支持的压缩方式（${method}）：${name}`), { status: 400 });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}
