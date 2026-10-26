/**
 * Paths that never enter a snapshot and are never restored from one: credentials, keys, local auth state.
 * One rule table (sensitive-paths.json, a git-ignore subset with `*` wildcards): a pattern without `/` matches any
 * path segment; a pattern with `/` matches that run of segments at any depth (`.aws/config` also catches
 * `infra/.aws/config`). Matching ignores case (Windows and macOS file systems do).
 */
import path from "node:path";
import patterns from "./sensitive-paths.json" with { type: "json" };
import { canonicalRoot, insideVcsMetadata, resolveScoped } from "@openagent/common/scoped";

export const SENSITIVE_PATH_PATTERNS: readonly string[] = Object.freeze([...patterns]);

const rules = patterns.map((p) => ({
  rooted: p.includes("/"),
  re: new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`, "i"),
}));

export function isSensitivePath(rel: string): boolean {
  const parts = rel.replaceAll("\\", "/").split("/").filter((p) => p && p !== ".");
  return rules.some(({ rooted, re }) =>
    rooted ? parts.some((_, i) => parts.some((__, j) => j >= i && re.test(parts.slice(i, j + 1).join("/")))) : parts.some((part) => re.test(part)),
  );
}

/**
 * Refuses to restore `rel` when it, or what it resolves to through links, is a sensitive path or lies inside `.git`
 * (or another version-control folder). The nearest existing ancestor is resolved (so a linked folder cannot disguise
 * `.aws/` or `.git/hooks`), the rest is appended as is. Creates nothing.
 */
export function assertSafeRestore(root: string, rel: string): void {
  const refuse = (): never => {
    throw new Error("credentials and local auth state are never restored from a snapshot");
  };
  if (isSensitivePath(rel)) refuse();
  let probe = rel;
  const suffix: string[] = [];
  for (;;) {
    let abs: string;
    try {
      abs = resolveScoped(root, probe);
    } catch (e) {
      if ((e as { status?: number }).status !== 404 || !probe || probe === ".") throw e;
      suffix.unshift(path.basename(probe));
      const parent = path.dirname(probe);
      if (parent === probe) throw e;
      probe = parent === "." ? "" : parent;
      continue;
    }
    const target = path.join(abs, ...suffix);
    if (isSensitivePath(path.relative(canonicalRoot(root), target))) refuse();
    if (insideVcsMetadata(root, target)) throw new Error("OpenAgent never writes into version-control metadata (.git and the like)");
    return;
  }
}
