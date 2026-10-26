// Runs before every test file: a test sees only the OPENAGENT_* variables it sets itself, never the developer's
// (an OPENAGENT_CURSOR_BIN in the shell would otherwise change what discovery finds). OPENAGENT_HOME comes from
// vitest.config.ts.
for (const k of Object.keys(process.env)) if (k.startsWith("OPENAGENT_") && k !== "OPENAGENT_HOME") delete process.env[k];
