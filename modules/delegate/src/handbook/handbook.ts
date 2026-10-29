/**
 * The agent handbook: who is good at what, each CLI's quirks, models and effort levels. One file, the home folder's
 * `handbook.md`, read by people and by every main agent; a project cannot bring its own.
 *
 * Writeback: a delegation may append its answer to a document as a signed CriticMarkup insertion that a person then
 * accepts or rejects, by editing the file or by asking their main agent to. The target `handbook` means the
 * handbook; any other target is a path relative to the project. The target must already exist: writing back never
 * creates a document.
 *
 * An answer can carry text from the web, and every project's main agent reads the handbook before it delegates. So
 * readers get the handbook without its undecided suggestions (`text`), and the suggestions apart, as data to show a
 * person (`suggestions`).
 */
import fs from "node:fs";
import path from "node:path";
import { detectEol, withEol } from "@longkeep/protocol/eol";
import { countPendingSuggestions, splitSuggestions, type PendingSuggestion } from "@longkeep/protocol/executors";
import { HANDBOOK_SEED } from "@longkeep/protocol/handbook";
import { makeCritic } from "@longkeep/protocol/criticmarkup";
import { HOME_LAYOUT } from "@longkeep/protocol/layout";
import { formatStamp } from "@longkeep/protocol/task";
import { ensureHome, existingHome, homePath } from "@longkeep/common/home";
import { atomicWriteFile, insideVcsMetadata, readTextScoped, resolveContractTarget, resolveScoped, resolveWritePathCreating } from "@longkeep/common/scoped";

/** The reserved writeback target that means "the handbook". */
export const HANDBOOK_TARGET = "handbook";

export interface HandbookState {
  exists: boolean;
  /** Absolute path of the handbook (where it is or would be created). */
  path: string;
  updated?: string;
  pendingSuggestions?: number;
  /** The whole file, suggestions included */
  content?: string;
  /** The file without the suggestions nobody has decided on: what a main agent may follow */
  text?: string;
  /** The undecided suggestions: executor output to show a person, never to follow */
  suggestions?: PendingSuggestion[];
}

interface Located {
  root: string;
  rel: string;
}

/** The handbook in the home folder; creates nothing (when the home folder does not exist yet, root is its future path). */
const locate = (env: NodeJS.ProcessEnv): Located => ({ root: existingHome(env) ?? homePath(env), rel: HOME_LAYOUT.handbook });

const absolute = (l: Located): string => path.join(l.root, ...l.rel.split("/"));

export async function readHandbook(env: NodeJS.ProcessEnv = process.env): Promise<HandbookState> {
  const located = locate(env);
  let content: string;
  try {
    content = (await readTextScoped(located.root, located.rel, 512 * 1024)).content;
  } catch {
    return { exists: false, path: absolute(located) };
  }
  const st = fs.statSync(resolveScoped(located.root, located.rel));
  const { accepted, suggestions } = splitSuggestions(content);
  return {
    exists: true,
    path: absolute(located),
    updated: formatStamp(st.mtime),
    pendingSuggestions: countPendingSuggestions(content),
    content,
    text: accepted,
    suggestions,
  };
}

/** Creates the handbook in the home folder from the bundled preset. Never overwrites an existing handbook. */
export function initHandbook(env: NodeJS.ProcessEnv = process.env): { action: "created" | "exists"; path: string } {
  const target = resolveWritePathCreating(ensureHome(env), HOME_LAYOUT.handbook);
  if (fs.existsSync(target)) return { action: "exists", path: target };
  atomicWriteFile(target, HANDBOOK_SEED);
  return { action: "created", path: target };
}

/** Where a writeback goes. Throws when the target does not exist yet. */
export function resolveWriteback(project: string, target: string, env: NodeJS.ProcessEnv = process.env): { root: string; rel: string; display: string } {
  if (target === HANDBOOK_TARGET) {
    const located = locate(env);
    try {
      resolveScoped(located.root, located.rel);
    } catch {
      throw new Error('there is no agent handbook yet; create it first with "longkeep handbook init" (or the init_handbook tool)');
    }
    return { root: located.root, rel: located.rel, display: absolute(located) };
  }
  let real: string;
  try {
    real = resolveScoped(project, target);
  } catch (e) {
    if ((e as { status?: number }).status === 404) throw new Error(`writeback target ${target} does not exist in the project; create the document first`);
    throw e;
  }
  if (insideVcsMetadata(project, real)) throw new Error(`writeback target ${target} is inside version-control metadata (.git and the like); Longkeep never writes there`);
  return { root: project, rel: target, display: target };
}

/** Appends the answer as a suggestion tagged with the executor's name at the end of the document, keeping its line endings. */
export function appendSuggestion(root: string, rel: string, x: { title: string; executor: string; answer: string; stamp: string }): void {
  // A document that is a link (AGENTS.md → CLAUDE.md) is written through the link, not replaced by a plain file.
  const abs = resolveWritePathCreating(root, resolveContractTarget(root, rel).rel);
  const body = fs.readFileSync(abs, "utf8");
  // Nothing inside the block may close the mark early: neither the answer nor the task title.
  const safe = (s: string) => s.replace(/\+\+\}/g, "++ }").replace(/\{\+\+/g, "{ ++");
  const block = makeCritic.ins(`\n## ${safe(x.title)} (${x.stamp})\n\n${safe(x.answer)}\n`, x.executor);
  const separator = body.endsWith("\n") ? "\n" : "\n\n";
  atomicWriteFile(abs, body + withEol(`${separator}${block}\n`, detectEol(body)));
}
