// git.ts: the forge's git layer. An in-memory object database per repository, the object codecs
// (blob, tree, commit, tag), the packfile reader (with OFS/REF deltas) and writer, the tree helpers the
// REST contents and merge paths use, and the smart-HTTP services: upload-pack (protocol v2 and v0) and
// receive-pack (v0 with report-status and side-band-64k). No git binary, only node:crypto and node:zlib.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const AGENT = 'makefun-forge/1.0';
const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE = ['', 'commit', 'tree', 'blob', 'tag'];
const OID_RE = /^[0-9a-f]{40}$/;
const MAX_BAND_PAYLOAD = 65515; // 65520 - 4 (length) - 1 (band byte)

export function isOid(value) {
  return typeof value === 'string' && OID_RE.test(value);
}

export function hashObject(type, data) {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

// ------------------------------------------------------------------ pkt-lines

const FLUSH = Buffer.from('0000');
const DELIM = Buffer.from('0001');

export function pkt(payload) {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((body.length + 4).toString(16).padStart(4, '0'));
  return Buffer.concat([head, body]);
}

/** Parse pkt-lines from `buf` until a flush (when stopAtFlush) or the end; returns packets and the offset reached. */
export function parsePkts(buf, stopAtFlush = false) {
  const packets = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenText = buf.toString('latin1', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`invalid pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packets.push('flush');
      offset += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (len === 1) { packets.push('delim'); offset += 4; continue; }
    if (len === 2) { packets.push('end'); offset += 4; continue; }
    if (len < 4 || offset + len > buf.length) throw new Error('truncated pkt-line');
    packets.push(buf.subarray(offset + 4, offset + len));
    offset += len;
  }
  return { packets, offset };
}

function lineOf(packet) {
  const text = packet.toString('utf8');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** Frame `data` into side-band packets on `band`. */
function sideband(band, data, out) {
  for (let offset = 0; offset < data.length; offset += MAX_BAND_PAYLOAD) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + MAX_BAND_PAYLOAD));
    const head = Buffer.from((chunk.length + 5).toString(16).padStart(4, '0'));
    out.push(head, Buffer.from([band]), chunk);
  }
}

// ------------------------------------------------------------------ object codecs

export function parseTree(data) {
  const entries = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('corrupt tree');
    const mode = data.toString('latin1', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry) {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function serializeTree(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(treeSortKey(a)), Buffer.from(treeSortKey(b))));
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function parseIdent(line) {
  const match = /^(.*?) ?<([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', time: 0, tz: '+0000' };
  return { name: match[1], email: match[2], time: Number(match[3]), tz: match[4] };
}

export function parseCommit(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const commit = { tree: '', parents: [], author: null, committer: null, message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5);
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7));
    else if (line.startsWith('author ')) commit.author = parseIdent(line.slice(7));
    else if (line.startsWith('committer ')) commit.committer = parseIdent(line.slice(10));
  }
  if (!commit.author) commit.author = parseIdent('');
  if (!commit.committer) commit.committer = commit.author;
  return commit;
}

export function parseTag(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const tag = { object: '', type: '', tag: '', tagger: null, message: split < 0 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7);
    else if (line.startsWith('type ')) tag.type = line.slice(5);
    else if (line.startsWith('tag ')) tag.tag = line.slice(4);
    else if (line.startsWith('tagger ')) tag.tagger = parseIdent(line.slice(7));
  }
  return tag;
}

function formatIdent(ident) {
  return `${ident.name} <${ident.email}> ${ident.time} ${ident.tz || '+0000'}`;
}

export function serializeCommit({ tree, parents, author, committer, message }) {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatIdent(author)}`, `committer ${formatIdent(committer ?? author)}`);
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${body}`, 'utf8');
}

// ------------------------------------------------------------------ deltas

function applyDelta(base, delta) {
  let offset = 0;
  const readSize = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
    }
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset |= delta[offset++];
      if (op & 0x02) copyOffset |= delta[offset++] << 8;
      if (op & 0x04) copyOffset |= delta[offset++] << 16;
      if (op & 0x08) copyOffset += delta[offset++] * 0x1000000;
      if (op & 0x10) copySize |= delta[offset++];
      if (op & 0x20) copySize |= delta[offset++] << 8;
      if (op & 0x40) copySize |= delta[offset++] << 16;
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

// ------------------------------------------------------------------ the object store

export class GitStore {
  constructor() {
    this.objects = new Map(); // oid -> { type, data }
    this.refs = new Map(); // full ref name -> oid
    this.head = 'refs/heads/main';
    this.version = 0; // bumped on every ref change (cache key)
    this.commitCache = new Map();
    this.treeCache = new Map();
    this.packEntries = new Map(); // oid -> deflated pack entry bytes
    this.responseCache = new Map();
    this.responseVersion = -1;
  }

  has(oid) {
    return this.objects.has(oid);
  }

  get(oid) {
    return this.objects.get(oid);
  }

  put(type, data) {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  commit(oid) {
    let parsed = this.commitCache.get(oid);
    if (parsed) return parsed;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    parsed = parseCommit(object.data);
    this.commitCache.set(oid, parsed);
    return parsed;
  }

  tree(oid) {
    let parsed = this.treeCache.get(oid);
    if (parsed) return parsed;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'tree') return null;
    parsed = parseTree(object.data);
    this.treeCache.set(oid, parsed);
    return parsed;
  }

  touch() {
    this.version += 1;
  }

  isEmpty() {
    return this.refs.size === 0;
  }

  /** Follow tags to the object they finally name. */
  peel(oid) {
    let current = oid;
    for (let guard = 0; guard < 32; guard += 1) {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return current;
  }

  /** A branch, tag, full ref, HEAD or (abbreviated) commit id to a commit oid, or null. */
  resolve(rev) {
    if (rev === undefined || rev === null || rev === '') rev = 'HEAD';
    if (rev === 'HEAD') return this.refs.get(this.head) ?? null;
    for (const name of [rev, `refs/heads/${rev}`, `refs/tags/${rev}`]) {
      const oid = this.refs.get(name);
      if (oid) return this.peel(oid);
    }
    if (/^[0-9a-f]{40}$/i.test(rev)) {
      const oid = rev.toLowerCase();
      return this.objects.has(oid) ? this.peel(oid) : null;
    }
    if (/^[0-9a-f]{4,39}$/i.test(rev)) {
      const prefix = rev.toLowerCase();
      for (const oid of this.objects.keys()) if (oid.startsWith(prefix) && this.objects.get(oid).type === 'commit') return oid;
    }
    return null;
  }

  branchNames() {
    const names = [];
    for (const ref of this.refs.keys()) if (ref.startsWith('refs/heads/')) names.push(ref.slice(11));
    return names.sort();
  }

  /** True when `ancestor` is reachable from `descendant` (or equal). */
  isAncestor(ancestor, descendant) {
    if (ancestor === descendant) return true;
    const seen = new Set([descendant]);
    const queue = [descendant];
    while (queue.length) {
      const commit = this.commit(queue.shift());
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
      }
    }
    return false;
  }

  ancestors(oid) {
    const seen = new Set();
    const queue = [oid];
    while (queue.length) {
      const current = queue.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.commit(current);
      if (commit) for (const parent of commit.parents) queue.push(parent);
    }
    return seen;
  }

  mergeBase(a, b) {
    const left = this.ancestors(a);
    const seen = new Set([b]);
    const queue = [b];
    while (queue.length) {
      const current = queue.shift();
      if (left.has(current)) return current;
      const commit = this.commit(current);
      if (!commit) continue;
      for (const parent of commit.parents) if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
    }
    return null;
  }

  /** Commits reachable from `oid`, newest committer time first (git log order, roughly). */
  log(oid, limit = Infinity) {
    const out = [];
    const seen = new Set([oid]);
    const heap = [oid];
    while (heap.length && out.length < limit) {
      let best = 0;
      for (let index = 1; index < heap.length; index += 1) {
        if ((this.commit(heap[index])?.committer.time ?? 0) > (this.commit(heap[best])?.committer.time ?? 0)) best = index;
      }
      const current = heap.splice(best, 1)[0];
      const commit = this.commit(current);
      if (!commit) continue;
      out.push(current);
      for (const parent of commit.parents) if (!seen.has(parent)) { seen.add(parent); heap.push(parent); }
    }
    return out;
  }

  /** Flatten a tree into path -> {mode, oid} for every non-tree entry. */
  flatten(treeOid, prefix = '', out = new Map()) {
    const entries = treeOid ? this.tree(treeOid) : null;
    if (!entries) return out;
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flatten(entry.oid, path, out);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
    return out;
  }

  /** Write the trees for a flat path map; returns the root tree oid. */
  buildTree(flat) {
    const root = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        let child = node.dirs.get(segments[index]);
        if (!child) { child = { files: new Map(), dirs: new Map() }; node.dirs.set(segments[index], child); }
        node = child;
      }
      node.files.set(segments[segments.length - 1], entry);
    }
    const write = (node) => {
      const entries = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: write(child) });
      return this.put('tree', serializeTree(entries));
    };
    return write(root);
  }

  /** The entry at `path` under a commit: {type:'blob'|'tree', mode, oid, name} or null. */
  lookupPath(commitOid, path) {
    const commit = this.commit(commitOid);
    if (!commit) return null;
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean === '') return { type: 'tree', mode: '40000', oid: commit.tree, name: '' };
    let treeOid = commit.tree;
    const segments = clean.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      const entries = this.tree(treeOid);
      if (!entries) return null;
      const entry = entries.find((candidate) => candidate.name === segments[index]);
      if (!entry) return null;
      if (index === segments.length - 1) return { type: entry.mode === '40000' ? 'tree' : 'blob', mode: entry.mode, oid: entry.oid, name: entry.name };
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return null;
  }

  /**
   * Three-way merge of trees at path granularity: {tree} or {conflicts}. A path changed differently on
   * both sides is a conflict; everything else takes the side that changed it.
   */
  mergeTrees(baseTree, oursTree, theirsTree) {
    const base = this.flatten(baseTree);
    const ours = this.flatten(oursTree);
    const theirs = this.flatten(theirsTree);
    const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    const result = new Map();
    const conflicts = [];
    const same = (a, b) => (a === undefined && b === undefined) || (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode);
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      let pick;
      if (same(o, t)) pick = o;
      else if (same(b, o)) pick = t;
      else if (same(b, t)) pick = o;
      else { conflicts.push(path); continue; }
      if (pick !== undefined) result.set(path, pick);
    }
    if (conflicts.length) return { conflicts };
    return { tree: this.buildTree(result) };
  }

  // ---------------------------------------------------------------- packs

  /** Read a packfile into the store; returns the oids it held. */
  readPack(pack) {
    if (pack.length < 32 || pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('not a packfile');
    const count = pack.readUInt32BE(8);
    const end = pack.length - 20;
    const checksum = createHash('sha1').update(pack.subarray(0, end)).digest('hex');
    if (checksum !== pack.toString('hex', end)) throw new Error('pack checksum mismatch');
    const byOffset = new Map();
    const pending = [];
    const oids = [];
    let offset = 12;
    for (let index = 0; index < count; index += 1) {
      const start = offset;
      let byte = pack[offset++];
      const typeCode = (byte >> 4) & 7;
      let size = byte & 0x0f;
      let shift = 4;
      while (byte & 0x80) {
        byte = pack[offset++];
        size += (byte & 0x7f) * 2 ** shift;
        shift += 7;
      }
      let baseOffset = -1;
      let baseOid = null;
      if (typeCode === 6) {
        byte = pack[offset++];
        let value = byte & 0x7f;
        while (byte & 0x80) {
          byte = pack[offset++];
          value = (value + 1) * 128 + (byte & 0x7f);
        }
        baseOffset = start - value;
      } else if (typeCode === 7) {
        baseOid = pack.toString('hex', offset, offset + 20);
        offset += 20;
      } else if (!CODE_TYPE[typeCode]) {
        throw new Error(`unknown pack object type ${typeCode}`);
      }
      const result = inflateSync(pack.subarray(offset, end), { info: true });
      const data = result.buffer;
      if (data.length !== size) throw new Error('pack object size mismatch');
      offset += result.engine.bytesWritten;
      if (typeCode === 6 || typeCode === 7) {
        pending.push({ start, baseOffset, baseOid, delta: data });
      } else {
        const type = CODE_TYPE[typeCode];
        const oid = this.put(type, data);
        byOffset.set(start, { type, data, oid });
        oids.push(oid);
      }
    }
    // Resolve deltas until no progress (bases may themselves be deltas).
    let progress = true;
    while (pending.length && progress) {
      progress = false;
      for (let index = 0; index < pending.length; index += 1) {
        const entry = pending[index];
        let base = null;
        if (entry.baseOid !== null) base = this.objects.get(entry.baseOid) ?? null;
        else base = byOffset.get(entry.baseOffset) ?? null;
        if (!base) continue;
        const data = applyDelta(base.data, entry.delta);
        const oid = this.put(base.type, data);
        byOffset.set(entry.start, { type: base.type, data, oid });
        oids.push(oid);
        pending.splice(index, 1);
        index -= 1;
        progress = true;
      }
    }
    if (pending.length) throw new Error(`${pending.length} delta object(s) have no base`);
    return oids;
  }

  packEntry(oid) {
    let entry = this.packEntries.get(oid);
    if (entry) return entry;
    const object = this.objects.get(oid);
    const header = [];
    let size = object.data.length;
    let first = (TYPE_CODE[object.type] << 4) | (size & 0x0f);
    size = Math.floor(size / 16);
    while (size > 0) {
      header.push(first | 0x80);
      first = size & 0x7f;
      size = Math.floor(size / 128);
    }
    header.push(first);
    entry = Buffer.concat([Buffer.from(header), deflateSync(object.data, { level: 1 })]);
    this.packEntries.set(oid, entry);
    return entry;
  }

  writePack(oids) {
    const head = Buffer.alloc(12);
    head.write('PACK', 0, 'latin1');
    head.writeUInt32BE(2, 4);
    head.writeUInt32BE(oids.length, 8);
    const parts = [head];
    const hash = createHash('sha1').update(head);
    for (const oid of oids) {
      const entry = this.packEntry(oid);
      parts.push(entry);
      hash.update(entry);
    }
    parts.push(hash.digest());
    return Buffer.concat(parts);
  }

  /** Every object reachable from `tips`; commits in `boundary` are treated as having no parents. */
  closure(tips, boundary = new Set()) {
    const seen = new Set();
    const stack = [...tips];
    while (stack.length) {
      const oid = stack.pop();
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = this.commit(oid);
        stack.push(commit.tree);
        if (!boundary.has(oid)) for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of this.tree(oid)) if (entry.mode !== '160000') stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  addTreeClosure(treeOid, have, out) {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop();
      if (have.has(oid) || out.has(oid) || !this.objects.has(oid)) continue;
      out.add(oid);
      const entries = this.tree(oid);
      if (!entries) continue;
      for (const entry of entries) {
        if (entry.mode === '160000') continue;
        if (entry.mode === '40000') stack.push(entry.oid);
        else if (!have.has(entry.oid) && this.objects.has(entry.oid)) out.add(entry.oid);
      }
    }
  }

  /**
   * The objects a fetch sends: what `wants` reach (depth-limited when `depth` is set) minus what the
   * client holds. Returns {objects, shallow, unshallow}.
   */
  enumerate(wants, haves, clientShallow, depth, includeTag) {
    const boundary = new Set(clientShallow);
    const have = this.closure(haves.filter((oid) => this.objects.has(oid)), boundary);
    const out = new Set();
    const shallow = [];
    const unshallow = [];
    const depthOf = new Map();
    const queue = [];
    for (const want of wants) {
      let oid = want;
      for (let guard = 0; guard < 32; guard += 1) {
        const object = this.objects.get(oid);
        if (!object) break;
        if (object.type === 'tag') {
          if (!have.has(oid)) out.add(oid);
          oid = parseTag(object.data).object;
          continue;
        }
        if (object.type === 'commit') queue.push([oid, 1]);
        else if (object.type === 'tree') this.addTreeClosure(oid, have, out);
        else if (!have.has(oid)) out.add(oid);
        break;
      }
    }
    for (let head = 0; head < queue.length; head += 1) {
      const [oid, level] = queue[head];
      const known = depthOf.get(oid);
      if (known !== undefined && known <= level) continue;
      depthOf.set(oid, level);
      const commit = this.commit(oid);
      if (!commit) continue;
      const held = have.has(oid);
      if (!held) {
        out.add(oid);
        this.addTreeClosure(commit.tree, have, out);
      }
      if (depth === null) {
        if (held) continue;
        for (const parent of commit.parents) queue.push([parent, level + 1]);
        continue;
      }
      if (level >= depth) {
        if (commit.parents.length > 0 && !shallow.includes(oid)) shallow.push(oid);
        continue;
      }
      if (boundary.has(oid) && commit.parents.length > 0 && !unshallow.includes(oid)) unshallow.push(oid);
      for (const parent of commit.parents) queue.push([parent, level + 1]);
    }
    for (const oid of unshallow) {
      const index = shallow.indexOf(oid);
      if (index >= 0) shallow.splice(index, 1);
    }
    if (includeTag) {
      for (const [ref, oid] of this.refs) {
        if (!ref.startsWith('refs/tags/') || out.has(oid) || have.has(oid)) continue;
        const object = this.objects.get(oid);
        if (object && object.type === 'tag' && (out.has(this.peel(oid)) || have.has(this.peel(oid)))) out.add(oid);
      }
    }
    return { objects: [...out], shallow, unshallow };
  }
}

// ------------------------------------------------------------------ smart HTTP

const UPLOAD_CAPS_V0 = `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want object-format=sha1 agent=${AGENT}`;
const RECEIVE_CAPS = `report-status report-status-v2 delete-refs side-band-64k quiet ofs-delta object-format=sha1 agent=${AGENT}`;

function sortedRefs(store) {
  return [...store.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function cached(store, key, build) {
  if (store.responseVersion !== store.version) {
    store.responseCache.clear();
    store.responseVersion = store.version;
  }
  let value = store.responseCache.get(key);
  if (value === undefined) {
    value = build();
    if (store.responseCache.size > 256) store.responseCache.clear();
    store.responseCache.set(key, value);
  }
  return value;
}

/** GET info/refs: {contentType, body}. `v2` when the client sent Git-Protocol: version=2 (upload-pack only). */
export function infoRefs(store, service, v2) {
  if (service === 'git-upload-pack' && v2) {
    return {
      contentType: 'application/x-git-upload-pack-advertisement',
      body: cached(store, 'adv:v2', () => Buffer.concat([
        pkt('version 2\n'),
        pkt(`agent=${AGENT}\n`),
        pkt('ls-refs=unborn\n'),
        pkt('fetch=shallow\n'),
        pkt('server-option\n'),
        pkt('object-format=sha1\n'),
        FLUSH,
      ])),
    };
  }
  const receive = service === 'git-receive-pack';
  return {
    contentType: `application/x-${service}-advertisement`,
    body: cached(store, `adv:${service}`, () => {
      const parts = [pkt(`# service=${service}\n`), FLUSH];
      const lines = [];
      if (!receive) {
        const headOid = store.refs.get(store.head);
        if (headOid) lines.push([headOid, 'HEAD']);
      }
      for (const [ref, oid] of sortedRefs(store)) {
        lines.push([oid, ref]);
        if (!receive && ref.startsWith('refs/tags/')) {
          const peeled = store.peel(oid);
          if (peeled !== oid) lines.push([peeled, `${ref}^{}`]);
        }
      }
      const caps = receive ? RECEIVE_CAPS : `${UPLOAD_CAPS_V0} symref=HEAD:${store.head}`;
      if (lines.length === 0) parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
      lines.forEach(([oid, name], index) => {
        parts.push(pkt(index === 0 ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
      });
      parts.push(FLUSH);
      return Buffer.concat(parts);
    }),
  };
}

function lsRefs(store, args) {
  const symrefs = args.includes('symrefs');
  const peel = args.includes('peel');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice(11));
  const match = (name) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts = [];
  if (match('HEAD')) {
    const headOid = store.refs.get(store.head);
    if (headOid) parts.push(pkt(`${headOid} HEAD${symrefs ? ` symref-target:${store.head}` : ''}\n`));
    else if (unborn) parts.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${store.head}` : ''}\n`));
  }
  for (const [ref, oid] of sortedRefs(store)) {
    if (!match(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = store.peel(oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function errorPacket(message) {
  return Buffer.concat([pkt(`ERR ${message}\n`), FLUSH]);
}

function fetchV2(store, args) {
  const wants = [];
  const haves = [];
  const clientShallow = [];
  let depth = null;
  let done = false;
  let includeTag = false;
  let deepenSince = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Math.max(1, parseInt(arg.slice(7), 10) || 1);
    else if (arg.startsWith('deepen-since ')) deepenSince = parseInt(arg.slice(13), 10);
    else if (arg === 'done') done = true;
    else if (arg === 'include-tag') includeTag = true;
    else if (arg.startsWith('want-ref ')) {
      const oid = store.refs.get(arg.slice(9).trim());
      if (oid) wants.push(oid);
    }
  }
  for (const want of wants) if (!store.has(want)) return errorPacket(`upload-pack: not our ref ${want}`);
  const out = [];
  if (!done) {
    const common = haves.filter((oid) => store.has(oid));
    out.push(pkt('acknowledgments\n'));
    if (common.length === 0) out.push(pkt('NAK\n'));
    for (const oid of common) out.push(pkt(`ACK ${oid}\n`));
    if (common.length === 0 && haves.length > 0) {
      out.push(FLUSH);
      return Buffer.concat(out);
    }
    out.push(pkt('ready\n'), DELIM);
  }
  if (deepenSince !== null && depth === null) depth = 1 << 30;
  const result = store.enumerate(wants, haves, clientShallow, depth, includeTag);
  if (depth !== null) {
    out.push(pkt('shallow-info\n'));
    for (const oid of result.shallow) out.push(pkt(`shallow ${oid}\n`));
    for (const oid of result.unshallow) out.push(pkt(`unshallow ${oid}\n`));
    out.push(DELIM);
  }
  out.push(pkt('packfile\n'));
  sideband(1, store.writePack(result.objects), out);
  out.push(FLUSH);
  return Buffer.concat(out);
}

function fetchV0(store, packets) {
  const wants = [];
  const haves = [];
  const clientShallow = [];
  let depth = null;
  let caps = new Set();
  let done = false;
  for (const packet of packets) {
    if (typeof packet === 'string') continue;
    const line = lineOf(packet);
    if (line.startsWith('want ')) {
      const parts = line.slice(5).split(' ');
      wants.push(parts[0]);
      if (wants.length === 1) caps = new Set(parts.slice(1));
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Math.max(1, parseInt(line.slice(7), 10) || 1);
    else if (line === 'done') done = true;
  }
  for (const want of wants) if (!store.has(want)) return errorPacket(`upload-pack: not our ref ${want}`);
  const out = [];
  const result = store.enumerate(wants, haves, clientShallow, depth, caps.has('include-tag'));
  if (depth !== null) {
    for (const oid of result.shallow) out.push(pkt(`shallow ${oid}\n`));
    for (const oid of result.unshallow) out.push(pkt(`unshallow ${oid}\n`));
    out.push(FLUSH);
  }
  const common = haves.filter((oid) => store.has(oid));
  if (!done && haves.length > 0 && common.length === 0) {
    out.push(pkt('NAK\n'));
    return Buffer.concat(out);
  }
  if (caps.has('multi_ack_detailed') && common.length) {
    for (const oid of common) out.push(pkt(`ACK ${oid} common\n`));
    out.push(pkt(`ACK ${common[common.length - 1]}\n`));
  } else {
    out.push(pkt('NAK\n'));
  }
  const pack = store.writePack(result.objects);
  if (caps.has('side-band-64k') || caps.has('side-band')) {
    sideband(1, pack, out);
    out.push(FLUSH);
  } else {
    out.push(pack);
  }
  return Buffer.concat(out);
}

/** POST git-upload-pack: the response body (v2 when asked for, v0 otherwise). */
export function uploadPack(store, body, v2) {
  return cached(store, `up:${v2 ? 2 : 0}:${body.toString('latin1')}`, () => {
    const { packets } = parsePkts(body);
    const first = packets.find((packet) => typeof packet !== 'string');
    const isV2 = v2 || (first !== undefined && lineOf(first).startsWith('command='));
    if (!isV2) return fetchV0(store, packets);
    let command = null;
    const args = [];
    let inArgs = false;
    for (const packet of packets) {
      if (packet === 'flush') break;
      if (packet === 'delim') { inArgs = true; continue; }
      if (typeof packet === 'string') continue;
      const line = lineOf(packet);
      if (!inArgs) {
        if (line.startsWith('command=')) command = line.slice(8);
      } else {
        args.push(line);
      }
    }
    if (command === 'ls-refs') return lsRefs(store, args);
    if (command === 'fetch') return fetchV2(store, args);
    return errorPacket(`unknown command ${JSON.stringify(command)}`);
  });
}

/**
 * POST git-receive-pack: apply the commands (each ref on its own: fast-forward only for branches) and
 * answer report-status, framed in side-band-64k when the client asked for it. Returns {body, updated}.
 */
export function receivePack(store, body, onRefChange) {
  const { packets, offset } = parsePkts(body, true);
  const commands = [];
  let caps = new Set();
  for (const packet of packets) {
    if (typeof packet === 'string') continue;
    let line = packet.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      caps = new Set(line.slice(nul + 1).trim().split(' '));
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    if (line.startsWith('shallow ') || line.startsWith('push-cert')) continue;
    const [oldOid, newOid, ref] = line.split(' ');
    if (!isOid(oldOid) || !isOid(newOid) || !ref) throw new Error(`malformed command ${JSON.stringify(line)}`);
    commands.push({ oldOid, newOid, ref });
  }
  let unpack = 'ok';
  const rest = body.subarray(offset);
  if (rest.length > 0) {
    try {
      store.readPack(rest);
    } catch (err) {
      unpack = String(err && err.message ? err.message : err).replace(/\n/g, ' ');
    }
  }
  const lines = [`unpack ${unpack}\n`];
  let changed = false;
  for (const command of commands) {
    const reason = unpack !== 'ok' ? 'unpacker error' : applyCommand(store, command);
    if (reason === null) {
      lines.push(`ok ${command.ref}\n`);
      changed = true;
      if (onRefChange) onRefChange(command);
    } else {
      lines.push(`ng ${command.ref} ${reason}\n`);
    }
  }
  if (changed) store.touch();
  const wantsReport = caps.has('report-status') || caps.has('report-status-v2');
  if (!wantsReport) return Buffer.alloc(0);
  const report = Buffer.concat([...lines.map((line) => pkt(line)), FLUSH]);
  if (!caps.has('side-band-64k') && !caps.has('side-band')) return report;
  const out = [];
  sideband(1, report, out);
  out.push(FLUSH);
  return Buffer.concat(out);
}

function applyCommand(store, { oldOid, newOid, ref }) {
  if (!ref.startsWith('refs/') || ref.includes('..') || /[\s~^:?*[\\]/.test(ref) || ref.endsWith('/') || ref.endsWith('.lock')) return 'funny refname';
  const current = store.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    if (current === ZERO_OID) return 'ref does not exist';
    if (oldOid !== ZERO_OID && oldOid !== current) return 'stale info';
    store.refs.delete(ref);
    return null;
  }
  const object = store.get(newOid);
  if (!object) return 'missing necessary objects';
  if (current === ZERO_OID) {
    if (oldOid !== ZERO_OID) return 'stale info';
  } else {
    if (oldOid === ZERO_OID) return 'already exists';
    if (oldOid !== current) return 'stale info';
    if (ref.startsWith('refs/heads/')) {
      if (object.type !== 'commit' || !store.isAncestor(current, newOid)) return 'non-fast-forward';
    }
  }
  if (ref.startsWith('refs/heads/') && object.type !== 'commit') return 'not a commit';
  if (store.refs.size === 0 && ref.startsWith('refs/heads/') && !store.refs.has(store.head)) store.head = ref;
  store.refs.set(ref, newOid);
  return null;
}
