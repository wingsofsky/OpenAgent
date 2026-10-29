/**
 * The git binary Longkeep runs for its own work (snapshots, working-folder fingerprints). LONGKEEP_GIT names a
 * specific executable; otherwise `git` from PATH. Longkeep never touches a project's own `.git`: snapshots live in
 * shadow repositories under the home folder.
 */
export function gitBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.LONGKEEP_GIT || "git";
}

