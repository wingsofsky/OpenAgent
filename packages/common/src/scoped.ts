/**
 * Scoped file access: the single gate for every path under a root (the OpenAgent home folder, a project, a record).
 *
 * Every caller passes a root (absolute) and a relative path; nothing else may build a path under a root.
 * - Rejected before touching the disk: non-strings, NUL, absolute and drive-relative paths, `..` segments, and on
 *   Windows every name Windows cannot hold (device names, alternate data streams, `:`, trailing dot or space).
 * - Links are resolved with the native realpath (on Windows it also expands 8.3 short names and returns the on-disk
 *   case), and the result must stay inside the root.
 * - Creating parents walks the path one segment at a time and checks each existing segment before creating
 *   anything, so a link that points outside is refused with zero side effects.
 * The attack cases are shared data: packages/protocol/src/path-attacks.json.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TEXT_CAP = 4 * 1024 * 1024;
const MAX_CAP = 64 * 1024 * 1024;

/** An HTTP-style status says what kind of refusal it is: 400 bad path, 403 escapes the root, 404 missing, 409 bad root. */
class ScopeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const WIN = process.platform === "win32";
const realpath = WIN ? fs.realpathSync.native : fs.realpathSync;
/** Windows device names, with or without an extension: writing one opens the device or leaves an undeletable file. */
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(\..*)?$/i;
/** `:` too: `a.md::$DATA` and `a.md:x` are NTFS alternate data streams, `C:x` is drive-relative. */
const WIN_BAD_CHAR = /[<>:"|?*\x00-\x1f]/;

/** Whether one path segment is unusable on this machine (always false outside Windows). */
function invalidOnWindows(segment: string): boolean {
  return WIN && (WIN_BAD_CHAR.test(segment) || WIN_RESERVED.test(segment) || /[. ]$/.test(segment));
}

/** Relative path → segments; `\` also separates on Windows. Throws a 400 for anything that is not a plain relative path. */
function segments(rel: unknown): string[] {
  if (typeof rel !== "string" || rel.includes("\0")) throw new ScopeError(400, "invalid path");
  if (path.isAbsolute(rel) || (WIN && /^[A-Za-z]:/.test(rel))) throw new ScopeError(400, "absolute paths are not accepted");
  const parts = rel.split(WIN ? /[\\/]/ : "/").filter((s) => s !== "" && s !== ".");
  for (const part of parts) {
    if (part === "..") throw new ScopeError(400, "path leaves its folder (..)");
    if (invalidOnWindows(part)) throw new ScopeError(400, `invalid file name: ${part}`);
  }
  return parts;
}

/** Windows extended-length prefixes (`\\?\D:\x`, `\\?\UNC\srv\share`) → the plain form; unchanged elsewhere. */
export function plainWinPath(p: string): string {
  if (!WIN) return p;
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice(8)}`;
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}

/** The canonical form of a root, the same form resolveScoped returns; compare against it, never against the raw root. */
export function canonicalRoot(root: string): string {
  try {
    return realpath(plainWinPath(root));
  } catch {
    throw new ScopeError(409, "root folder is not accessible");
  }
}

/** Whether `real` is `base` or inside it (also when base is a drive root such as `D:\`). */
const within = (base: string, real: string): boolean =>
  real === base || real.startsWith(base.endsWith(path.sep) ? base : base + path.sep);

const VCS_DIRS = new Set([".git", ".hg", ".svn", ".jj"]);

/**
 * Whether an entry resolved under root (resolveScoped's result) sits inside a version-control metadata folder. It
 * checks the resolved path, so a link or a Windows short name (GIT~1) that leads into `.git` counts too.
 */
export function insideVcsMetadata(root: string, real: string): boolean {
  return path.relative(canonicalRoot(root), real).split(path.sep).some((s) => VCS_DIRS.has(s.toLowerCase()));
}

/** Path of an existing entry under root, links resolved. */
export function resolveScoped(root: string, rel: string): string {
  const parts = segments(rel);
  const rootReal = canonicalRoot(root);
  let real: string;
  try {
    real = realpath(path.join(rootReal, ...parts));
  } catch {
    throw new ScopeError(404, "path is not accessible");
  }
  if (!within(rootReal, real)) throw new ScopeError(403, "path escapes the root folder");
  return real;
}

/**
 * Path to write under root, creating missing parent folders. Existing segments are resolved and checked before
 * anything is created; new segments are plain names under a checked parent, so they cannot leave the root.
 * The leaf itself may not exist yet; a link at the leaf is replaced by atomicWriteFile, never followed.
 */
export function resolveWritePathCreating(root: string, rel: string): string {
  // All segments are checked before any mkdir: on Windows a slipped `a/..\..\x` would be normalised outside first.
  const parts = segments(rel);
  if (parts.length === 0) throw new ScopeError(400, "no file name given");
  const rootReal = canonicalRoot(root);
  let current = rootReal;
  for (const part of parts.slice(0, -1)) {
    const candidate = path.join(current, part);
    let existed = fs.existsSync(candidate) || isLink(candidate);
    if (!existed) {
      try {
        fs.mkdirSync(candidate);
      } catch (e) {
        // Another process created it meanwhile: check it like an existing one.
        if ((e as NodeJS.ErrnoException).code === "EEXIST") existed = true;
        else throw new ScopeError(500, `could not create folder: ${(e as Error).message}`);
      }
    }
    if (existed) {
      let real: string;
      try {
        real = realpath(candidate);
      } catch {
        throw new ScopeError(404, "path is not accessible");
      }
      if (!within(rootReal, real)) throw new ScopeError(403, "path escapes the root folder");
      if (!fs.statSync(real).isDirectory()) throw new ScopeError(400, "a parent of the path is not a folder");
      current = real;
    } else {
      current = candidate;
    }
  }
  const target = path.join(current, parts[parts.length - 1]);
  if (!within(rootReal, target)) throw new ScopeError(403, "path escapes the root folder");
  return target;
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * On Windows a rename fails with EPERM / EBUSY / EACCES while another process (antivirus, indexer, OneDrive, an
 * editor) holds the target; it is usually released within tens of milliseconds. Retry with backoff, about 0.6 s total.
 */
function renameRetrying(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!WIN || attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * 2 ** attempt);
    }
  }
}

/**
 * Durable atomic write: temporary file in the same folder, fsync, rename, fsync the folder. Readers only ever see
 * the old or the new content, and a link at the target is replaced rather than followed.
 * `target` must come from resolveWritePathCreating.
 */
export function atomicWriteFile(target: string, data: string | Buffer): void {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.openagent-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    renameRetrying(tmp, target);
  } catch (e) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
  // Folder fsync is best effort: Windows cannot open a folder handle, and content integrity does not depend on it.
  try {
    const dfd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    /* not supported on this platform */
  }
}

/** WHATWG windows-1252 for 0x80-0x9F (the five undefined bytes map to themselves). */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

/**
 * Some Node versions decode windows-1252 0x80-0x9F as latin1 control characters (an em dash becomes U+0097).
 * Map them per the WHATWG table; on a correct Node this changes nothing.
 */
function decodeLegacy(buf: Uint8Array, encoding: string): string {
  const text = new TextDecoder(encoding).decode(buf);
  if (encoding !== "windows-1252") return text;
  return text.replace(/[\x80-\x9f]/g, (c) => String.fromCharCode(CP1252_HIGH[c.charCodeAt(0) - 0x80]));
}

interface TextRead {
  content: string;
  size: number;
  truncated: boolean;
  /** utf-8, utf-16le, utf-16be, binary, or the legacy encoding chardetng guessed (gbk, big5, shift_jis, …). */
  encoding: string;
}

/** Read text with encoding detection: UTF-16 BOM, then NUL means binary, then strict UTF-8, then chardetng. */
export async function readTextScoped(root: string, rel: string, max?: number): Promise<TextRead> {
  const abs = resolveScoped(root, rel);
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw new ScopeError(400, "not a file");
  const cap = Math.min(max ?? DEFAULT_TEXT_CAP, MAX_CAP, st.size);
  const fh = await fsp.open(abs, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(cap);
    const { bytesRead } = await fh.read(buf, 0, cap, 0);
    buf = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  const truncated = st.size > buf.length;
  const utf16 = buf.length >= 2 ? (buf[0] === 0xff && buf[1] === 0xfe ? "utf-16le" : buf[0] === 0xfe && buf[1] === 0xff ? "utf-16be" : null) : null;
  if (utf16) {
    const content = new TextDecoder(utf16).decode(buf);
    return { content: content.startsWith("\ufeff") ? content.slice(1) : content, size: st.size, truncated, encoding: utf16 };
  }
  const body = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  if (body.subarray(0, 8192).includes(0)) return { content: "", size: st.size, truncated, encoding: "binary" };
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(body), size: st.size, truncated, encoding: "utf-8" };
  } catch {
    const encoding = await detectEncoding(buf, !truncated);
    return { content: decodeLegacy(buf, encoding), size: st.size, truncated, encoding };
  }
}

/** chardetng (WASM) is loaded only when a file is not UTF-8. Its package entry targets bundlers, so load the Node build by path. */
async function detectEncoding(buf: Uint8Array, complete: boolean): Promise<string> {
  const url = pathToFileURL(createRequire(import.meta.url).resolve("chardetng-wasm/dist/chardetng_wasm.js")).href;
  const { EncodingDetector } = (await import(url)) as {
    EncodingDetector: { new: () => { feed(b: Uint8Array, last: boolean): void; guess(tld: undefined, allowUtf8: boolean): string; free(): void } };
  };
  const detector = EncodingDetector.new();
  try {
    detector.feed(buf, complete);
    return detector.guess(undefined, true).toLowerCase();
  } finally {
    detector.free();
  }
}

/**
 * Write target for a contract file (CLAUDE.md, AGENTS.md): follows a link at the leaf when it stays inside the root.
 *
 * atomicWriteFile replaces a leaf link, which is the right default against writing through a link to the outside.
 * But many repositories make AGENTS.md a link to CLAUDE.md, and replacing it would split the two files. So the
 * relative path is rewritten to the link's target first, and the caller still passes the result through
 * resolveWritePathCreating. A link pointing outside the root is refused.
 */
export function resolveContractTarget(root: string, rel: string): { rel: string; followed: string | null } {
  const parts = segments(rel);
  const rootReal = canonicalRoot(root);
  const joined = path.join(rootReal, ...parts);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(joined);
  } catch {
    // Not there yet: a plain new file, but only if its nearest existing ancestor is inside the root.
    for (let dir = path.dirname(joined); ; ) {
      let real: string;
      try {
        real = realpath(dir);
      } catch {
        const up = path.dirname(dir);
        if (up === dir) throw new ScopeError(403, "path escapes the root folder");
        dir = up;
        continue;
      }
      if (!within(rootReal, real)) throw new ScopeError(403, `a parent of ${rel} is outside the root folder`);
      return { rel, followed: null };
    }
  }
  let real: string;
  if (!st.isSymbolicLink()) {
    // A plain file can still be reached through a linked parent folder: answer for the whole path, not just the leaf.
    if (!within(rootReal, realpath(joined))) throw new ScopeError(403, "path escapes the root folder");
    return { rel, followed: null };
  }
  try {
    real = realpath(joined);
  } catch {
    throw new ScopeError(404, `${rel} is a broken link`);
  }
  if (!within(rootReal, real)) throw new ScopeError(403, `${rel} links outside the root folder`);
  const target = path.relative(rootReal, real).split(path.sep).join("/");
  if (!target || target.startsWith("..")) throw new ScopeError(403, "link target is outside the root folder");
  return { rel: target, followed: rel };
}
