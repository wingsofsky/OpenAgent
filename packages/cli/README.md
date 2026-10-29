# The `longkeep` command

`node <repo>/packages/cli/src/cli.ts` is the `longkeep` command. It has no commands of its own: it reads `modules/<name>/module.json` of every module in the checkout and runs the commands they list, so a sparse checkout with one module shows only that module's commands. `--help` lists them, `--version` prints the version, and an unknown command exits with code 2 and a pointer to [INSTALL.md](../../INSTALL.md).

Each module's README documents its commands.
