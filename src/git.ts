// git smart HTTP: protocol v2 upload-pack, v0 upload-pack, and v0 receive-pack,
// plus the packfile format (PACK v2, OFS_DELTA and REF_DELTA reads, plain writes).
//
// The wire shapes here are git's own protocol formats, implemented from the
// protocol specification: pkt-lines, advertisements, ls-refs/fetch commands,
// sideband packs, and the report-status reply. No git binary is used anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildTag,
  collectReachable,
  collectReachableBounded,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type Repo,
  ZERO_OID,
} from './store.ts';
import { readBody, sendError } from './util.ts';

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export type PktItem = { kind: 'line'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' };

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

/** One pkt-line: a 4-hex-digit length (itself included) followed by the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

/** Parse pkt-lines from the head of a buffer; `endOffset` is where parsing stopped. */
export function parsePktLines(buffer: Buffer): { items: PktItem[]; endOffset: number } {
  const items: PktItem[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (!Number.isFinite(length) || length < 0) break;
    if (length === 0) {
      items.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      items.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    items.push({ kind: 'line', data: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { items, endOffset: offset };
}

/** A pkt-line whose payload is a UTF-8 line, trailing newline stripped. */
function lineText(item: PktItem): string | null {
  if (item.kind !== 'line') return null;
  return item.data.toString('utf8').replace(/\n$/, '');
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

const PACK_OBJECT_TYPES: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};
const PACK_TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Read a size/type varint from a pack; returns [type, size, bytesConsumed]. */
function readPackVarint(buffer: Buffer, offset: number): [number, number, number] {
  let byte = buffer[offset] as number;
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let consumed = 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[offset + consumed] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    consumed += 1;
  }
  return [type, size, consumed];
}

/** Read an OFS_DELTA base offset varint; returns [offset, bytesConsumed]. */
function readOffsetVarint(buffer: Buffer, offset: number): [number, number] {
  let byte = buffer[offset] as number;
  let value = byte & 0x7f;
  let consumed = 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[offset + consumed] as number;
    value = ((value + 1) << 7) | (byte & 0x7f);
    consumed += 1;
  }
  return [value, consumed];
}

/** Read a delta's size varint; returns [size, bytesConsumed]. */
function readDeltaVarint(buffer: Buffer, offset: number): [number, number] {
  let size = 0;
  let shift = 0;
  let consumed = 0;
  for (;;) {
    const byte = buffer[offset + consumed] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    consumed += 1;
    if ((byte & 0x80) === 0) break;
  }
  return [size, consumed];
}

/** Apply a git delta to a base object's bytes, returning the result. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const [sourceSize, sourceConsumed] = readDeltaVarint(delta, 0);
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const [targetSize, targetConsumed] = readDeltaVarint(delta, sourceConsumed);
  const parts: Buffer[] = [];
  let offset = sourceConsumed + targetConsumed;
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset] as number;
    offset += 1;
    if ((opcode & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((opcode & (1 << i)) !== 0) {
          copyOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((opcode & (0x10 << i)) !== 0) {
          copySize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode !== 0) {
      parts.push(delta.subarray(offset, offset + opcode));
      produced += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (produced !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(parts);
}

/**
 * Parse a PACK v2 buffer into full objects. Delta bases may come from the same
 * pack (OFS_DELTA by byte offset, REF_DELTA by oid) or, for thin packs, from
 * `lookup` — the receiving repository's object store. Each returned object
 * carries its oid, computed once here, so the caller need not hash it again.
 */
export function parsePack(
  buffer: Buffer,
  lookup: (oid: string) => GitObject | undefined,
): Array<GitObject & { oid: string }> {
  if (buffer.length < 12 || buffer.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buffer.readUInt32BE(4);
  const count = buffer.readUInt32BE(8);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const objects: Array<GitObject & { oid: string }> = [];
  const byOffset = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const startOffset = offset;
    const [typeId, size, headerConsumed] = readPackVarint(buffer, offset);
    offset += headerConsumed;
    let type: GitObjectType;
    let data: Buffer;
    if (typeId === 6) {
      const [baseOffset, offsetConsumed] = readOffsetVarint(buffer, offset);
      offset += offsetConsumed;
      const base = byOffset.get(startOffset - baseOffset);
      if (!base) throw new Error('ofs-delta base not found in pack');
      const [used, inflated] = inflateObject(buffer, offset, size);
      offset += used;
      data = applyDelta(base.data, inflated);
      type = base.type;
    } else if (typeId === 7) {
      const baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const base = byOid.get(baseOid) ?? lookup(baseOid);
      if (!base) throw new Error(`ref-delta base ${baseOid} is not available`);
      const [used, inflated] = inflateObject(buffer, offset, size);
      offset += used;
      data = applyDelta(base.data, inflated);
      type = base.type;
    } else {
      type = PACK_OBJECT_TYPES[typeId] as GitObjectType;
      if (!type) throw new Error(`unknown pack object type ${typeId}`);
      const [used, inflated] = inflateObject(buffer, offset, size);
      data = inflated;
      offset += used;
      if (data.length !== size) throw new Error('object size mismatch in pack');
    }
    const oid = hashObject(type, data);
    const object: GitObject & { oid: string } = { type, data, oid };
    objects.push(object);
    byOffset.set(startOffset, object);
    byOid.set(oid, object);
  }
  return objects;
}

/** Adler-32 of a buffer: the checksum a zlib stream ends with, big-endian. */
function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  let i = 0;
  // Defer the modulus (safe for 5552 bytes at a time: b stays below 2^31).
  while (i < data.length) {
    const end = Math.min(data.length, i + 5552);
    while (i < end) {
      a += data[i] as number;
      b += a;
      i += 1;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate the one zlib stream starting at `offset`, whose inflated size is
 * `expectedSize`. Fast path: inflate a bounded window once — inflateSync
 * ignores trailing bytes, so one call yields the data when the window holds
 * the whole stream — then locate the stream's end from its Adler-32 trailer
 * (the four bytes ending the stream are the Adler-32 of the inflated data).
 * When the trailer occurs exactly once inside the window it must be the
 * stream's end (the window holds the whole stream, so its trailer is in
 * the window); with several candidates each is verified by inflating that
 * exact prefix. Falls back to the probing search when the window does not
 * hold the whole stream or no candidate verifies. Returns
 * [consumedBytes, inflatedData].
 */
function inflateObject(buffer: Buffer, offset: number, expectedSize: number): [number, Buffer] {
  const remaining = buffer.length - offset;
  const window = Math.min(remaining, Math.max(8192, expectedSize * 3 + 256));
  if (window > 0) {
    try {
      const data = inflateSync(buffer.subarray(offset, offset + window));
      if (data.length === expectedSize) {
        const needle = Buffer.alloc(4);
        needle.writeUInt32BE(adler32(data), 0);
        const windowEnd = offset + window;
        const first = buffer.indexOf(needle, offset);
        if (first >= 0 && first + 4 <= windowEnd) {
          const second = buffer.indexOf(needle, first + 1);
          if (second < 0 || second + 4 > windowEnd) {
            return [first - offset + 4, data];
          }
          let searchFrom = first;
          for (let tries = 0; tries < 8; tries += 1) {
            const at = searchFrom;
            const len = at - offset + 4;
            try {
              const check = inflateSync(buffer.subarray(offset, offset + len));
              if (check.length === expectedSize && check.equals(data)) return [len, data];
            } catch {
              // Not the true end; keep looking for a later occurrence.
            }
            const next = buffer.indexOf(needle, at + 1);
            if (next < 0 || next + 4 > windowEnd) break;
            searchFrom = next;
          }
        }
      }
    } catch {
      // The window did not hold the whole stream: fall through to probing.
    }
  }
  const used = inflatedLength(buffer, offset);
  return [used, inflateSync(buffer.subarray(offset, offset + used))];
}

/** How many bytes of `buffer` starting at `offset` form one zlib stream. */
function inflatedLength(buffer: Buffer, offset: number): number {
  // A prefix shorter than the stream is truncated (inflateSync throws); a
  // prefix at or past its end inflates cleanly, trailing bytes ignored. So
  // the smallest prefix that inflates is exactly the stream's length: find it
  // by exponential probing, then binary-search between the last failure and
  // the first success.
  const high = buffer.length - offset;
  let lastFail = 0;
  let firstOk = -1;
  let probe = Math.min(high, 64);
  while (probe <= high) {
    try {
      inflateSync(buffer.subarray(offset, offset + probe));
      firstOk = probe;
      break;
    } catch {
      lastFail = probe;
      if (probe === high) break; // the whole remainder failed: no stream here
      probe = Math.min(high, probe * 2);
    }
  }
  if (firstOk === -1) {
    inflateSync(buffer.subarray(offset)); // throws the real error
    return high;
  }
  let low = lastFail + 1;
  let top = firstOk;
  while (low < top) {
    const mid = (low + top) >> 1;
    try {
      inflateSync(buffer.subarray(offset, offset + mid));
      top = mid;
    } catch {
      low = mid + 1;
    }
  }
  return low;
}

/** Serialize objects as a PACK v2 buffer with no deltas (plain, deflated objects). */
export function buildPack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  // Deterministic order: commits, trees, blobs, tags, then by oid. The oid is
  // computed once per object, not once per comparison (a sort does O(n log n)
  // comparisons and hashing the data each time is pure waste on large packs).
  const rank: Record<GitObjectType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  const withOid = objects.map((object) => ({ object, oid: hashObject(object.type, object.data) }));
  withOid.sort((a, b) => {
    const byType = rank[a.object.type] - rank[b.object.type];
    if (byType !== 0) return byType;
    return a.oid.localeCompare(b.oid);
  });
  const sorted = withOid.map((entry) => entry.object);
  for (const object of sorted) {
    const typeId = PACK_TYPE_IDS[object.type] as number;
    const size = object.data.length;
    // Varint: low 4 bits of size in the first byte, then 7 bits per byte.
    const sizeBytes: number[] = [];
    let remaining = size >> 4;
    while (remaining > 0) {
      sizeBytes.push(remaining & 0x7f);
      remaining >>= 7;
    }
    const headerBytes = Buffer.alloc(1 + sizeBytes.length);
    headerBytes[0] = (typeId << 4) | (size & 0x0f) | (sizeBytes.length > 0 ? 0x80 : 0);
    for (let i = 0; i < sizeBytes.length; i += 1) {
      headerBytes[1 + i] = (sizeBytes[i] as number) | (i + 1 < sizeBytes.length ? 0x80 : 0);
    }
    parts.push(headerBytes, deflateSync(object.data));
  }
  const trailer = Buffer.alloc(20);
  createHash('sha1').update(Buffer.concat(parts)).digest().copy(trailer);
  parts.push(trailer);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

const AGENT = 'forge/1.0';

const UPLOAD_PACK_CAPS = [
  'multi_ack',
  'thin-pack',
  'side-band',
  'side-band-64k',
  'ofs-delta',
  'shallow',
  'deepen-since',
  'deepen-not',
  'deepen-relative',
  'no-progress',
  'include-tag',
  'multi_ack_detailed',
  'allow-tip-sha1-in-want',
  'allow-reachable-sha1-in-want',
  'no-done',
  'symref=HEAD:refs/heads/main',
  'filter',
  'object-format=sha1',
  `agent=${AGENT}`,
];

const RECEIVE_PACK_CAPS = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`];

/** Refs in advertisement order: HEAD first, then every ref sorted by name. */
function refList(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const headTip = repo.defaultTip();
  const head = headTip === null ? null : { name: 'HEAD', oid: headTip };
  return head === null ? refs : [head, ...refs];
}

/** The peeled target of a tag ref, or null when the ref is not an annotated tag. */
function peeledTarget(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  try {
    return parseTag(object.data).object;
  } catch {
    return null;
  }
}

/** A v0 advertisement: `# service=...` preamble, flush, then the ref lines. */
function advertiseV0(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_PACK_CAPS : RECEIVE_PACK_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = refList(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  refs.forEach((ref, index) => {
    let line = `${ref.oid} ${ref.name}`;
    if (index === 0) line += `\0${caps.join(' ')}`;
    line += '\n';
    parts.push(pktLine(line));
    const peeled = peeledTarget(repo, ref.oid);
    if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
  });
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A v2 advertisement: `version 2`, the capabilities, then a flush. */
function advertiseV2(): Buffer {
  const lines = ['version 2', 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1', `agent=${AGENT}`];
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

// ---------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to send, in pack order. */
  objects: GitObject[];
  /** Haves that are ancestors of a want (empty means NAK). */
  acks: string[];
  /** Commits at the shallow boundary. */
  shallow: string[];
  /** Client-shallow commits now fully included. */
  unshallow: string[];
}

/**
 * Which objects a fetch sends. `wants` are the commits asked for, `haves` the
 * commits the client already holds, `clientShallow` the client's shallow
 * commits, `deepen` the history depth (null = all of it). The pack holds every
 * object reachable from the included commits except what the haves already cover.
 */
export function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  deepen: number | null,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // What the client already holds. A have that is a shallow boundary only
  // covers itself and its tree (the client does not hold its parents), so the
  // exclusion walk must not cross any shallow commit's parent links.
  const clientShallowSet = new Set(clientShallow);
  const haveReachable = new Set<string>();
  for (const have of haves) {
    try {
      for (const oid of collectReachableBounded([have], lookup, clientShallowSet)) haveReachable.add(oid);
    } catch {
      // A have the server does not know is simply not excludable.
    }
  }
  // Walk the wanted commits breadth-first, generation by generation. A want
  // that names a tag (or any non-commit object) is sent as-is, and its target
  // is walked in its place at the same generation.
  const includedCommits = new Map<string, number>(); // oid -> generation (want = 1)
  const extraObjects = new Set<string>();
  const queue: Array<{ oid: string; generation: number }> = wants.map((oid) => ({ oid, generation: 1 }));
  const shallow = new Set<string>();
  while (queue.length > 0) {
    const { oid, generation } = queue.shift() as { oid: string; generation: number };
    if (includedCommits.has(oid) || extraObjects.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) throw new Error(`want ${oid} is not available`);
    if (object.type === 'tag') {
      extraObjects.add(oid);
      queue.push({ oid: parseTag(object.data).object, generation });
      continue;
    }
    if (object.type !== 'commit') {
      extraObjects.add(oid);
      continue;
    }
    includedCommits.set(oid, generation);
    const parents = parseCommit(object.data).parents;
    if (deepen !== null && generation >= deepen) {
      if (parents.length > 0) shallow.add(oid);
      continue;
    }
    for (const parent of parents) queue.push({ oid: parent, generation: generation + 1 });
  }
  // Everything reachable from the included commits, plus the extra objects,
  // minus what the haves already cover. With a depth limit, each included
  // commit contributes only itself and its tree (never its parents — a parent
  // contributes its own closure only if it is itself included), so a depth-1
  // fetch carries the tip's tree and blobs and nothing older.
  const wanted = new Set<string>(extraObjects);
  const included = new Set(includedCommits.keys());
  if (deepen === null) {
    for (const reachable of collectReachable(included, lookup)) wanted.add(reachable);
  } else {
    for (const reachable of collectReachableBounded(included, lookup, included)) wanted.add(reachable);
  }
  for (const oid of haveReachable) wanted.delete(oid);
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const generation = includedCommits.get(oid);
    if (generation === undefined) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    const parentsIncluded = parents.every((parent) => includedCommits.has(parent));
    if (parentsIncluded) unshallow.push(oid);
  }
  const acks: string[] = [];
  for (const have of haves) {
    if (!repo.objects.has(have)) continue;
    if (wants.some((want) => isAncestor(repo, have, want) || have === want)) acks.push(have);
  }
  return { objects, acks, shallow: [...shallow], unshallow };
}

// ---------------------------------------------------------------------------
// pack cache (the clone workload fetches the same pack fifty times at once)
// ---------------------------------------------------------------------------

const packCache = new Map<string, Buffer>();

function packCacheKey(repo: Repo, plan: FetchPlan, wants: string[], haves: string[], clientShallow: string[], deepen: number | null): string {
  const refsKey = [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, oid]) => `${name}=${oid}`)
    .join(',');
  return `${repo.id}|${refsKey}|${wants.join(',')}|${haves.join(',')}|${clientShallow.join(',')}|${deepen ?? ''}|${plan.shallow.join(',')}|${plan.unshallow.join(',')}`;
}

function cachedPack(repo: Repo, plan: FetchPlan, wants: string[], haves: string[], clientShallow: string[], deepen: number | null): Buffer {
  const key = packCacheKey(repo, plan, wants, haves, clientShallow, deepen);
  const cached = packCache.get(key);
  if (cached) return cached;
  const pack = buildPack(plan.objects);
  if (packCache.size >= 64) {
    const oldest = packCache.keys().next().value as string | undefined;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, pack);
  return pack;
}

/** Split a byte stream into sideband band-1 packets (≤65515 data bytes each). */
function sidebandPack(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([0x01]), chunk])));
  }
  return packets;
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function isV2(req: IncomingMessage, body: Buffer): boolean {
  if ((req.headers['git-protocol'] ?? '') === 'version=2') return true;
  const { items } = parsePktLines(body);
  const first = items[0];
  const text = lineText(first ?? { kind: 'flush' });
  return text !== null && text.startsWith('command=');
}

function sendUploadPackResult(res: ServerResponse, body: Buffer): void {
  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'content-length': String(body.length),
    'cache-control': 'no-cache',
  });
  res.end(body);
}

/** v2 ls-refs: the ref lines the client asked for, then a flush. */
function handleLsRefs(repo: Repo, items: PktItem[]): Buffer {
  let peel = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const item of items) {
    // The arguments (peel, symrefs, unborn, ref-prefix) come AFTER the delim
    // packet, so a delim must be skipped, not treated as the end of the list.
    const text = lineText(item);
    if (text === null) continue;
    if (text === 'peel') peel = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTip = repo.defaultTip();
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  if (matches('HEAD')) {
    if (headTip === null) {
      if (unborn) parts.push(pktLine(`unborn HEAD symref-target:${headTarget}\n`));
    } else {
      parts.push(pktLine(`${headTip} HEAD symref-target:${headTarget}\n`));
    }
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, oid] of refs) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledTarget(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    line += '\n';
    parts.push(pktLine(line));
    if (name.startsWith('refs/tags/')) {
      const peeled = peeledTarget(repo, oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 fetch: named sections (acknowledgments only while the client has not said done), then the packfile section (always sent, even when empty), then a flush. */
function handleFetchV2(repo: Repo, items: PktItem[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen: number | null = null;
  let done = false;
  for (const item of items) {
    if (item.kind === 'flush') break;
    if (item.kind === 'delim') continue;
    const text = lineText(item);
    if (text === null) continue;
    if (text === 'command=fetch') continue;
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) clientShallow.push(text.slice(8).trim());
    else if (text === 'done') done = true;
    else if (text.startsWith('deepen ')) {
      const depth = parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(depth) && depth > 0) deepen = depth;
    }
  }
  const plan = planFetch(repo, wants, haves, clientShallow, deepen);
  const parts: Buffer[] = [];
  if (!done && haves.length > 0) {
    // Negotiation is still open: acknowledge what is common, then stop.
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_DELIM);
    if (plan.acks.length === 0) {
      parts.push(PKT_FLUSH);
      return Buffer.concat(parts);
    }
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(cachedPack(repo, plan, wants, haves, clientShallow, deepen)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v0 fetch: NAK/ACK and shallow lines, then the sideband pack (always sent, even when empty), then a flush. */
function handleFetchV0(repo: Repo, items: PktItem[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen: number | null = null;
  let done = false;
  let section = 0;
  for (const item of items) {
    if (item.kind === 'flush') {
      section += 1;
      continue;
    }
    const text = lineText(item);
    if (text === null) continue;
    const bare = text.split('\0')[0] as string;
    if (section === 0) {
      // Wants section: want lines (the first carries the capabilities), shallow
      // boundaries and deepen lines all live here.
      if (bare.startsWith('want ')) wants.push(bare.slice(5).trim());
      else if (bare.startsWith('shallow ')) clientShallow.push(bare.slice(8).trim());
      else if (bare.startsWith('deepen ')) {
        const depth = parseInt(bare.slice(7).trim(), 10);
        if (Number.isFinite(depth) && depth > 0) deepen = depth;
      }
    } else {
      // Negotiation section: have lines and done.
      if (bare.startsWith('have ')) haves.push(bare.slice(5).trim());
      else if (bare === 'done') done = true;
    }
  }
  const plan = planFetch(repo, wants, haves, clientShallow, deepen);
  const parts: Buffer[] = [];
  if (!done && haves.length > 0) {
    // Negotiation round: acknowledge and wait for more haves (no pack yet).
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack} continue\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(cachedPack(repo, plan, wants, haves, clientShallow, deepen)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const v2 = isV2(req, body);
  const { items } = parsePktLines(body);
  let out: Buffer;
  if (v2) {
    const first = lineText(items[0] ?? { kind: 'flush' }) ?? '';
    if (first === 'command=ls-refs') out = handleLsRefs(repo, items.slice(1));
    else if (first === 'command=fetch') out = handleFetchV2(repo, items);
    else throw new Error(`unknown upload-pack v2 command ${first}`);
  } else {
    out = handleFetchV0(repo, items);
  }
  sendUploadPackResult(res, out);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

function sendReceivePackResult(res: ServerResponse, body: Buffer): void {
  res.writeHead(200, {
    'content-type': 'application/x-git-receive-pack-result',
    'content-length': String(body.length),
    'cache-control': 'no-cache',
  });
  res.end(body);
}

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  store: { putObjects: (repo: Repo, objects: readonly GitObject[], oids?: readonly (string | undefined)[]) => void; setRef: (repo: Repo, ref: string, oid: string | null) => void },
): Promise<void> {
  const body = await readBody(req);
  const { items, endOffset } = parsePktLines(body);
  const commands: RefCommand[] = [];
  for (const item of items) {
    if (item.kind === 'flush') break;
    const text = lineText(item);
    if (text === null) continue;
    const bare = text.split('\0')[0] as string;
    const parts = bare.trim().split(' ');
    if (parts.length !== 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) continue;
    commands.push({ oldOid, newOid, ref });
  }
  const packBytes = body.subarray(endOffset);
  const report: string[] = [];
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes, (oid) => repo.objects.get(oid));
      // Objects are stored even for refs that end up refused; their ids were
      // already computed while parsing the pack, so they are not hashed again.
      store.putObjects(
        repo,
        objects,
        objects.map((object) => object.oid),
      );
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (unpackError !== null) {
    // The report is a pkt-line stream (its own flush included), carried as
    // band-1 sideband data; the outer flush ends the response.
    const reportStream = Buffer.concat([pktLine(`unpack ${unpackError}\n`), PKT_FLUSH]);
    const out = Buffer.concat([...sidebandPack(reportStream), PKT_FLUSH]);
    sendReceivePackResult(res, out);
    return;
  }
  report.push('unpack ok');
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let refusal: string | null = null;
    if (command.newOid === ZERO_OID) {
      if (current === undefined) refusal = 'ref does not exist';
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) refusal = 'old ref does not match';
    } else {
      if (!repo.objects.has(command.newOid)) {
        refusal = 'object not found';
      } else if (command.oldOid === ZERO_OID) {
        if (current !== undefined) refusal = 'already exists';
      } else if (current === undefined) {
        refusal = 'ref does not exist';
      } else if (command.oldOid !== current) {
        refusal = 'old ref does not match';
      } else if (command.newOid !== current && !isAncestor(repo, current, command.newOid)) {
        refusal = 'non-fast-forward';
      }
    }
    if (refusal !== null) {
      report.push(`ng ${command.ref} ${refusal}`);
      continue;
    }
    store.setRef(repo, command.ref, command.newOid === ZERO_OID ? null : command.newOid);
    report.push(`ok ${command.ref}`);
  }
  const reportStream = Buffer.concat([...report.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  const parts = sidebandPack(reportStream);
  parts.push(PKT_FLUSH);
  sendReceivePackResult(res, Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

export function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo | null, service: string): void {
  if (repo === null) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found\n');
    return;
  }
  const isV2Request = (req.headers['git-protocol'] ?? '') === 'version=2';
  const body = service === 'git-receive-pack' || !isV2Request ? advertiseV0(service as 'git-upload-pack' | 'git-receive-pack', repo) : advertiseV2();
  const contentType =
    service === 'git-receive-pack'
      ? 'application/x-git-receive-pack-advertisement'
      : 'application/x-git-upload-pack-advertisement';
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(body.length),
    'cache-control': 'no-cache',
  });
  res.end(body);
}

/** Build an annotated tag object (used by the REST refs endpoint for tags). */
export function makeTagObject(fields: { object: string; type: GitObjectType; tag: string; message: string }): GitObject {
  return { type: 'tag', data: buildTag(fields) };
}
