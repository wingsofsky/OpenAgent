/**
 * `openagent doctor`: all five executors point at one fake CLI (.cjs, launched with the current Node like in
 * delegation). Pins where the binary was found, the version, the sign-in rules (status command / credentials file /
 * unrecognised = unknown) and the parsing of the minimal probe. Never touches installed CLIs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { doctorCommand, formatDoctor, runDoctor } from "../src/executors/doctor.ts";

const CHECK = String.fromCodePoint(0x2713);
const FAKE = `
const a = process.argv.slice(2);
const has = (x) => a.includes(x);
if (a[0] === "--version") { console.log("fake-cli 9.9.9"); process.exit(0); }
if (a[0] === "login" && a[1] === "status") { console.log("Logged in using ChatGPT"); process.exit(0); }
if (a[0] === "auth" && a[1] === "status") { console.log(JSON.stringify({ loggedIn: false }, null, 2)); process.exit(0); }
if (a[0] === "status") { console.log("\\u001b[32m\\u2713\\u001b[39m Logged in as someone"); process.exit(0); }
if (has("exec")) { const o = a[a.indexOf("-o") + 1]; require("node:fs").writeFileSync(o, "ok"); process.exit(0); }
if (has("--print-timeout")) { console.error("ERROR: model not entitled"); process.exit(3); }
console.log(JSON.stringify({ result: "ok", session_id: "s1" }));
`;

describe("openagent doctor", () => {
  let base: string;
  let fake: string;
  let home: string;
  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "of-doctor-")));
    fake = path.join(base, "fake-cli.cjs");
    fs.writeFileSync(fake, FAKE);
    home = path.join(base, "openagent-home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "executors.json"), JSON.stringify({ cursor: { bin: fake } }));
    vi.spyOn(os, "homedir").mockReturnValue(base);
  });
  afterAll(() => {
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true });
  });

  // Discovery also looks under the per-user app folders: point them at the temporary folder too, so a CLI installed
  // on this machine is never found
  const env = () => ({
    ...process.env,
    PATH: "",
    OPENAGENT_SEARCH_PATH: "",
    LOCALAPPDATA: base,
    APPDATA: base,
    OPENAGENT_HOME: home,
    OPENAGENT_CODEX_BIN: fake,
    OPENAGENT_AGY_BIN: fake,
    OPENAGENT_GROK_BIN: fake,
    OPENAGENT_CLAUDE_BIN: fake,
  });

  it("binary source, version and sign-in: a recognised status command says yes / no, a missing credentials file or no rule says unknown", async () => {
    const r = await runDoctor({ env: env() });
    const row = (id: string) => r.executors.find((x) => x.id === id)!;
    expect(r.executors.map((x) => x.id)).toEqual(["codex", "agy", "grok", "cursor", "claude"]);
    expect(row("codex")).toMatchObject({ bin: fake, binSource: "env", version: "fake-cli 9.9.9", login: { state: "yes" } });
    expect(row("cursor").binSource).toBe("config");
    expect(row("cursor").login).toEqual({ state: "yes", detail: `cursor-agent status: ${CHECK} Logged in as someone` });
    expect(row("claude").login).toEqual({ state: "no", detail: 'claude auth status: "loggedIn": false' });
    expect(row("grok").login.state).toBe("unknown");
    expect(row("agy").login.state).toBe("unknown");
    expect(r.probed).toBe(false);
    fs.mkdirSync(path.join(base, ".grok"), { recursive: true });
    fs.writeFileSync(path.join(base, ".grok", "auth.json"), "{}");
    expect((await runDoctor({ env: env() })).executors.find((x) => x.id === "grok")!.login.state).toBe("yes");
  });

  it("the home folder's executors.json bin applies, and a broken file does not stop the check", async () => {
    const config = path.join(home, "executors.json");
    fs.writeFileSync(config, JSON.stringify({ cursor: { bin: fake }, claude: { bin: "/home-config/claude" } }));
    const e = { ...env(), OPENAGENT_CLAUDE_BIN: "" };
    expect((await runDoctor({ env: e, quickTimeoutMs: 2000 })).executors.find((x) => x.id === "claude")).toMatchObject({ bin: "/home-config/claude", binSource: "config" });
    fs.writeFileSync(config, "{ broken");
    const r = await runDoctor({ env: env() });
    expect(r.executors).toHaveLength(5);
    expect(r.executors.find((x) => x.id === "cursor")!.bin).toBeNull();
    fs.writeFileSync(config, JSON.stringify({ cursor: { bin: fake } }));
  });

  it("not installed: install hint, no version or sign-in run", async () => {
    const r = await runDoctor({ env: { PATH: "", OPENAGENT_SEARCH_PATH: "", OPENAGENT_HOME: path.join(base, "empty-home"), LOCALAPPDATA: base, APPDATA: base } });
    for (const x of r.executors) expect(x).toMatchObject({ bin: null, binSource: null, version: null });
    expect(r.executors[0].installHint).toMatch(/codex not found/);
    expect(formatDoctor(r)).toMatch(/codex\s+not installed/);
  });

  it("probe: arguments and answer parsing use the delegation spec; a failure reports the last stderr line", async () => {
    const r = await runDoctor({ env: env(), probe: true, probeTimeoutMs: 30_000 });
    const row = (id: string) => r.executors.find((x) => x.id === id)!;
    expect(row("codex").probe).toMatchObject({ ok: true, answer: "ok", exitCode: 0 });
    expect(row("grok").probe).toMatchObject({ ok: true, answer: "ok" });
    expect(row("agy").probe).toMatchObject({ ok: false, exitCode: 3, error: "ERROR: model not entitled" });
    expect(formatDoctor(r)).toMatch(/probe\s+failed.*model not entitled/);
  }, 30_000);

  it("the command: unknown options exit 2 with the usage; --help exits 0", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await doctorCommand(["--nope"])).toBe(2);
      expect(err.mock.calls.flat().join("\n")).toMatch(/unknown option --nope/);
      expect(await doctorCommand(["--help"])).toBe(0);
      expect(log.mock.calls.flat().join("\n")).toMatch(/Usage: openagent doctor/);
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });
});
