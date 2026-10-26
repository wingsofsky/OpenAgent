/**
 * Link fixtures that work on an unprivileged Windows account (no Developer Mode) as well as macOS/Linux.
 *
 * - Directory links: Windows gets an NTFS junction. Creating one needs no privilege, and for the code under
 *   test it behaves like a symlink: lstat().isSymbolicLink(), Dirent.isSymbolicLink(), readlinkSync and
 *   realpathSync all treat it as a link (rmSync / unlinkSync remove the link, never the target).
 * - File links: there is no unprivileged equivalent (a hard link is not a symlink, and product code checks
 *   isSymbolicLink()). linkFile() reports whether the link exists so a test can skip exactly the assertions
 *   that need it. GitHub's Windows runners are admin, so CI always creates the link and runs them.
 */
import fs from "node:fs";
import path from "node:path";

/** Skip note for assertions that need a file symlink the local Windows account may not create. */
export const FILE_SYMLINK_SKIP = "file symlink needs Developer Mode on Windows";

/** Directory link: an NTFS junction on Windows (no privilege needed), a plain symlink elsewhere. */
export function linkDir(target: string, link: string): void {
  if (process.platform === "win32") {
    // Junction targets are stored absolute; resolve a relative target the way a symlink would (from the link's directory).
    fs.symlinkSync(path.resolve(path.dirname(link), target), link, "junction");
  } else {
    fs.symlinkSync(target, link);
  }
}

/**
 * File symlink. Returns false only on Windows when unprivileged symlink creation is refused (EPERM);
 * every other error is thrown, and on macOS/Linux the link is always created or the call throws.
 */
export function linkFile(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, "file");
    return true;
  } catch (e) {
    if (process.platform === "win32" && (e as NodeJS.ErrnoException).code === "EPERM") return false;
    throw e;
  }
}
