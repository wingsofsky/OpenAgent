/**
 * The git binary OpenAgent runs for its own work (snapshots, working-folder fingerprints). OPENAGENT_GIT names a
 * specific executable; otherwise `git` from PATH. OpenAgent never touches a project's own `.git`: snapshots live in
 * shadow repositories under the home folder.
 */
export function gitBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENAGENT_GIT || "git";
}

