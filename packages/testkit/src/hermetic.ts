// Runs before every test file: a test sees only the LONGKEEP_* variables it sets itself, never the developer's
// (an LONGKEEP_CURSOR_BIN in the shell would otherwise change what discovery finds). LONGKEEP_HOME comes from
// vitest.config.ts.
for (const k of Object.keys(process.env)) if (k.startsWith("LONGKEEP_") && k !== "LONGKEEP_HOME") delete process.env[k];
