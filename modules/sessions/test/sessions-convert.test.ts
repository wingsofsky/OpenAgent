import { describe, expect, it } from "vitest";
import {
  archiveChecksum,
  archiveUntouched,
  BUCKET_DELEGATION,
  BUCKET_MISC,
  BUCKET_TEMP,
  BUCKET_UNKNOWN,
  buildPromptBooks,
  detectFormat,
  isDelegationSession,
  isSubsetSession,
  parseSession,
  projectBucket,
  redactText,
  renderMarkdown,
  sanitizeBucket,
  suggestFileName,
  type Turn,
  withChecksum,
} from "../src/convert.ts";
import { DELEGATION_FOLLOW_UP_HEADING, DELEGATION_PROMPT_FIRST_LINE, DELEGATION_TASK_HEADING } from "@longkeep/protocol/delegation-prompt";
import { FAKE_KEY, FAKE_PEM, FAKE_S2_KEY, FAKE_SHORT_KEY, FAKE_TOKEN } from "@longkeep/testkit/fake-secrets";

const ccLine = (o: Record<string, unknown>) => JSON.stringify(o);
/** Non-Latin text for fixtures is built at runtime: the repository itself stays English. */
const cjk = (...codes: number[]) => String.fromCodePoint(...codes);

const ccFixture = [
  ccLine({ type: "queue-operation", timestamp: "2026-08-27T10:03:00.000Z" }),
  ccLine({
    type: "user",
    sessionId: "feed0000-aaaa-4bbb-8ccc-000000000000",
    isSidechain: false,
    cwd: "/Users/dev/project",
    gitBranch: "main",
    timestamp: "2026-08-27T10:03:01.000Z",
    message: { role: "user", content: "First user message\n\nwith a blank line, kept verbatim." },
  }),
  ccLine({ type: "custom-title", sessionId: "feed0000", customTitle: "Hand-set title" }),
  ccLine({ type: "ai-title", sessionId: "feed0000", aiTitle: "AI title" }),
  ccLine({
    type: "assistant",
    sessionId: "feed0000",
    timestamp: "2026-08-27T10:03:02.000Z",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "inner monologue never archived" }] },
  }),
  ccLine({
    type: "assistant",
    sessionId: "feed0000",
    timestamp: "2026-08-27T10:03:03.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Conclusion first." }] },
  }),
  ccLine({
    type: "assistant",
    sessionId: "feed0000",
    timestamp: "2026-08-27T10:03:04.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Read", input: {} },
        { type: "tool_use", name: "Read", input: {} },
        { type: "tool_use", name: "Bash", input: {} },
      ],
    },
  }),
  // Tool output comes back on a user line: not a person speaking, no turn
  ccLine({
    type: "user",
    sessionId: "feed0000",
    timestamp: "2026-08-27T10:03:05.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "huge tool output" }] },
  }),
  // Slash command expansion is harness noise
  ccLine({
    type: "user",
    sessionId: "feed0000",
    timestamp: "2026-08-27T10:04:00.000Z",
    message: { role: "user", content: "<command-name>/foo</command-name>" },
  }),
  // Sub-agent transcripts are skipped by default
  ccLine({
    type: "user",
    sessionId: "feed0000",
    isSidechain: true,
    timestamp: "2026-08-27T10:05:00.000Z",
    message: { role: "user", content: "sub-agent internal prompt" },
  }),
  ccLine({
    type: "user",
    sessionId: "feed0000",
    timestamp: "2026-08-27T10:06:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "Second one, as a content array." }] },
  }),
].join("\n");

describe("Claude Code transcripts", () => {
  it("detects the format, prefers the hand-set title, reads id / project / branch", () => {
    expect(detectFormat(ccFixture)).toBe("claude-code");
    const s = parseSession(ccFixture, "claude-code");
    expect(s.title).toBe("Hand-set title");
    expect(s.id).toBe("feed0000-aaaa-4bbb-8ccc-000000000000");
    expect(s.cwd).toBe("/Users/dev/project");
    expect(s.branch).toBe("main");
  });

  it("user turns are verbatim; tool output, command noise and sidechains make no turn; assistant tools fold", () => {
    const s = parseSession(ccFixture, "claude-code");
    expect(s.turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(s.turns[0].text).toBe("First user message\n\nwith a blank line, kept verbatim.");
    expect(s.turns[1].text).toBe("Conclusion first.");
    expect(s.turns[1].tools.get("Read")).toBe(2);
    expect(s.turns[1].tools.get("Bash")).toBe(1);
    expect(s.turns[2].text).toBe("Second one, as a content array.");
  });

  it("includes sidechain turns with sidechains: true", () => {
    const s = parseSession(ccFixture, "claude-code", { sidechains: true });
    expect(s.turns.some((t) => t.text.includes("sub-agent internal prompt"))).toBe(true);
  });

  it("renders without thinking, with tools on one line and the user's text intact", () => {
    const md = renderMarkdown(parseSession(ccFixture, "claude-code"), { importedAt: "2026-08-28 09:00", originPath: "/tmp/x.jsonl" });
    expect(md).toContain("# Session: Hand-set title");
    expect(md).toContain("- source: claude-code · id `feed0000-aaaa-4bbb-8ccc-000000000000`");
    expect(md).toContain("- project: /Users/dev/project (branch main)");
    expect(md).toMatch(/^- time: .+ → .+ · turns: 2 user \/ 1 assistant · tools 3 · dispatches 0$/m);
    expect(md).toContain("- imported: 2026-08-28 09:00 · original transcript: `/tmp/x.jsonl`");
    expect(md).toMatch(/^## User · \d\d-\d\d \d\d:\d\d$/m);
    expect(md).toContain("First user message");
    expect(md).toContain("> [tools] Read ×2 · Bash");
    expect(md).not.toContain("inner monologue");
    expect(md).not.toContain("huge tool output");
  });

  it("archive name: time stamp + first 8 id characters + title slug (unsafe characters washed out, letters kept)", () => {
    const s = parseSession(ccFixture, "claude-code");
    const word = cjk(0x6587, 0x6863);
    s.title = `a/b:c*d ${word}?pack`;
    expect(suggestFileName(s)).toBe(`${suggestFileName(s).slice(0, 13)}-feed0000-a-b-c-d-${word}-pack.md`);
    expect(suggestFileName(s)).toMatch(/^20260827-\d{4}-feed0000-/);
  });

  it("never lets a secret reach the title or the file name, even when the title cuts through it", () => {
    const key = FAKE_KEY;
    const msg = (content: string) => ccLine({ type: "user", sessionId: "k1", timestamp: "2026-08-28T09:00:00.000Z", message: { role: "user", content } });
    for (const first of [`${key} please rotate this`, `Use this one: ${key}`]) {
      const s = parseSession(msg(first), "claude-code");
      expect(s.title).not.toContain("Q7xR2mK9");
      expect(s.title).toContain("[redacted:openai/anthropic");
      expect(suggestFileName(s)).not.toContain("Q7xR2mK9");
      expect(suggestFileName(s)).not.toContain("sk-test");
    }
    // A key-like token that no pattern knows is still kept out of the file name
    expect(suggestFileName({ startedAt: null, id: "k2", title: "deploy Zq8Wv3Lp7Rt2Nm6Kx1Bc5Hd9" })).toBe("00000000-0000-k2-deploy-redacted.md");
  });

  it("sums the main agent's fresh tokens and keeps cache reads apart", () => {
    const raw = [
      ccLine({ type: "user", sessionId: "u1", timestamp: "2026-08-28T09:00:00.000Z", message: { role: "user", content: "hi" } }),
      ccLine({
        type: "assistant",
        sessionId: "u1",
        timestamp: "2026-08-28T09:00:01.000Z",
        message: { role: "assistant", usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 9000 }, content: [{ type: "text", text: "hello" }] },
      }),
    ].join("\n");
    const s = parseSession(raw, "claude-code");
    expect(s.usage).toEqual({ fresh: 115, cached: 9000 });
    expect(renderMarkdown(s)).toMatch(/^- main-agent usage: 115 tokens \(.*9000 cache-read tokens/m);
  });
});

describe("other formats", () => {
  it("codex: event_msg is the fallback", () => {
    const raw = [
      JSON.stringify({ type: "session_meta", timestamp: "2026-08-27T10:00:00Z", payload: { id: "abc123", cwd: "/w" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-08-27T10:00:01Z", payload: { type: "user_message", message: "codex user message" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-08-27T10:00:02Z", payload: { type: "agent_message", message: "codex reply" } }),
    ].join("\n");
    expect(detectFormat(raw)).toBe("codex");
    const s = parseSession(raw, "codex");
    expect(s.id).toBe("abc123");
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "codex user message"],
      ["assistant", "codex reply"],
    ]);
  });

  it("codex: response_item wins over event_msg", () => {
    const raw = [
      JSON.stringify({ type: "response_item", timestamp: "t", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "the real one" }] } }),
      JSON.stringify({ type: "event_msg", timestamp: "t", payload: { type: "user_message", message: "echo" } }),
    ].join("\n");
    const s = parseSession(raw, "codex");
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].text).toBe("the real one");
  });

  it("gemini history checkpoints", () => {
    const raw = JSON.stringify({
      history: [
        { role: "user", parts: [{ text: "gemini question" }] },
        { role: "model", parts: [{ text: "gemini answer" }] },
      ],
    });
    expect(detectFormat(raw)).toBe("gemini-history");
    const s = parseSession(raw, "gemini-history");
    expect(s.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("generic jsonl fallback: role + content is enough", () => {
    const raw = [
      JSON.stringify({ role: "human", content: "a user message from any agent" }),
      JSON.stringify({ role: "ai", text: "a reply from any agent" }),
      JSON.stringify({ kind: "noise" }),
    ].join("\n");
    expect(detectFormat(raw)).toBe("generic-jsonl");
    const s = parseSession(raw, "generic-jsonl");
    expect(s.turns).toHaveLength(2);
    expect(s.title).toBe("a user message from any agent");
  });

  it("does not mistake empty input or plain text for a transcript", () => {
    expect(detectFormat("")).toBeNull();
    expect(detectFormat("plain text is not a transcript")).toBeNull();
  });
});

const dispatchFixture = [
  ccLine({
    type: "user",
    sessionId: "aaaa1111-0000-0000-0000-000000000000",
    timestamp: "2026-08-28T09:00:00.000Z",
    message: { role: "user", content: "Send out a code review" },
  }),
  ccLine({
    type: "assistant",
    sessionId: "aaaa1111",
    timestamp: "2026-08-28T09:00:05.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Dispatching a reviewer." },
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Agent",
          input: { description: "Review the parser", subagent_type: "general-purpose", model: "opus", prompt: "You are a reviewer with no context... list the problems only." },
        },
        { type: "tool_use", id: "toolu_02", name: "Read", input: {} },
      ],
    },
  }),
  ccLine({
    type: "user",
    sessionId: "aaaa1111",
    timestamp: "2026-08-28T09:10:00.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "Verdict: two cases fail." }] },
  }),
].join("\n");

describe("sub-agent dispatches", () => {
  it("are kept apart: full prompt plus the stitched reply; ordinary tools still fold", () => {
    const s = parseSession(dispatchFixture, "claude-code");
    const asst = s.turns.find((t) => t.role === "assistant")!;
    expect(asst.agents).toHaveLength(1);
    expect(asst.agents[0].prompt).toContain("no context");
    expect(asst.agents[0].model).toBe("opus");
    expect(asst.agents[0].reply).toBe("Verdict: two cases fail.");
    expect(asst.tools.get("Read")).toBe(1);
    expect(asst.tools.has("Agent")).toBe(false);
    const md = renderMarkdown(s);
    expect(md).toContain("> [dispatch] general-purpose/opus · Review the parser");
    expect(md).toContain("<details><summary>Dispatch prompt and reply</summary>");
    expect(md).toContain("Reply:");
    expect(md).toContain("Verdict: two cases fail.");
  });
});

describe("fork detection", () => {
  const mk = (msgs: string[]) =>
    parseSession(
      msgs.map((m, i) => ccLine({ type: "user", sessionId: "s", timestamp: `2026-08-28T09:0${i}:00.000Z`, message: { role: "user", content: m } })).join("\n"),
      "claude-code",
    );
  it("strict inclusion of the user messages ⇒ possible subset; equal or unrelated ⇒ no", () => {
    const a = mk(["one", "two"]);
    const b = mk(["one", "two", "three"]);
    const c = mk(["four"]);
    expect(isSubsetSession(a, b)).toBe(true);
    expect(isSubsetSession(b, a)).toBe(false);
    expect(isSubsetSession(a, a)).toBe(false);
    expect(isSubsetSession(c, b)).toBe(false);
  });
});

describe("redaction (allowlist + keyword-line entropy + suspects)", () => {
  it("replaces allowlisted patterns, including uncommon prefixes such as s2k-", () => {
    const r = redactText(`S2 API Key: ${FAKE_S2_KEY}\nanother one ${FAKE_SHORT_KEY}`);
    expect(r.text).not.toContain("s2k-AbCdEf");
    expect(r.text).not.toContain("sk-abcDEF");
    expect(r.text).toContain("[redacted:semantic-scholar length 25]");
    expect(r.redactions.map((x) => x.type).sort()).toEqual(["openai/anthropic", "semantic-scholar"].sort());
  });
  it("replaces high-entropy tokens on keyword lines; leaves pure hex (git hashes) alone", () => {
    const r = redactText("my token: Qz9RtY7uIoP2aSdF4gHjK1lZ\ncommit a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0");
    expect(r.text).toContain("[redacted:keyword-line");
    expect(r.text).toContain("a1b2c3d4e5f6");
  });
  it("recognises the Chinese keywords for credential and secret key", () => {
    const r = redactText(`${cjk(0x5bc6, 0x94a5)}: Qz9RtY7uIoP2aSdF4gHjK1lZ`);
    expect(r.text).toContain("[redacted:keyword-line");
  });
  it("only lists a very long mixed token without a keyword as a suspect", () => {
    const tok = FAKE_TOKEN;
    const r = redactText(`the body mentions ${tok} like this`);
    expect(r.text).toContain(tok);
    expect(r.suspects).toEqual([`${tok.slice(0, 12)}… (length ${tok.length})`]);
  });
  it("does not list slug, file-name or tool-name shapes as suspects", () => {
    const r = redactText(
      ["mcp__Claude_Browser__read_network_requests_v2X9", "2026-08-20__project_notes_review__ab12cd34", "how-to-name-things-and-why-It-Matters-In-2026-Ai"].join("\n"),
    );
    expect(r.suspects).toHaveLength(0);
  });
  it("replaces a PEM block whole", () => {
    const r = redactText(FAKE_PEM("MIIabc"));
    expect(r.text).toContain("[redacted:pem");
    expect(r.text).not.toContain("MIIabc");
  });
});

describe("distilled books", () => {
  it("collects user messages verbatim, rule paragraphs by regex (and says it is not a summary), dispatches", () => {
    const s = parseSession(dispatchFixture, "claude-code");
    const rule = `${cjk(0x4ee5, 0x540e)} every report goes into the reports folder.`; // "from now on" in Chinese
    const s2 = parseSession(
      ccLine({
        type: "user",
        sessionId: "bbbb2222-0000-0000-0000-000000000000",
        timestamp: "2026-08-28T10:00:00.000Z",
        message: { role: "user", content: `From now on, always run the tests first.\n${rule}\nJust chatting.` },
      }),
      "claude-code",
    );
    const books = buildPromptBooks([
      { session: s, file: "a.md" },
      { session: s2, file: "b.md" },
    ]);
    expect(books.counts.user).toBe(2);
    expect(books.counts.agent).toBe(1);
    expect(books.counts.rules).toBe(2);
    expect(books.userPromptsMd).toContain("Send out a code review");
    expect(books.rulesMd).toContain("This is a regex hit, not a summary");
    expect(books.rulesMd).toContain("From now on, always run the tests first.");
    expect(books.rulesMd).toContain(rule);
    expect(books.rulesMd).not.toContain("Just chatting");
    expect(books.agentPromptsMd).toContain("general-purpose/opus");
  });
});

describe("grok / agy / cursor transcripts", () => {
  it("grok: keeps the typed user_query and assistant text, folds tools and backend search, drops reasoning and tool_result, fills gaps from summary meta", () => {
    const raw = [
      JSON.stringify({ type: "system", content: "You are Grok" }),
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_info>\nOS: windows\n</user_info>\n<rules>...</rules>" }] }),
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<system-reminder>skills</system-reminder>" }], synthetic_reason: "skills" }),
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>\nList the modules\n</user_query>" }], prompt_index: 0 }),
      JSON.stringify({ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "xxx", status: "done" }),
      JSON.stringify({
        type: "assistant",
        content: "Reading the docs first.",
        tool_calls: [
          { id: "c1", name: "read_file", arguments: "{}" },
          { id: "c2", name: "read_file", arguments: "{}" },
        ],
        model_id: "grok-4.6",
        reasoning_effort: "high",
      }),
      JSON.stringify({ type: "tool_result", tool_call_id: "c1", content: "secret output not archived" }),
      JSON.stringify({ type: "backend_tool_call", kind: { tool_type: "web_search", action: { query: "q" } } }),
      JSON.stringify({ type: "assistant", content: "Conclusion: three modules.", model_id: "grok-4.6", reasoning_effort: "high" }),
    ].join("\n");
    expect(detectFormat(raw)).toBe("grok");
    const s = parseSession(raw, "grok", {
      meta: { id: "a1b2c3d4-1", cwd: "E:\\work\\x", startedAt: "2026-09-04T10:44:00Z", endedAt: "2026-09-04T10:49:00Z", title: "Module list", model: "grok-4.6 · reasoning high" },
    });
    expect(s.source).toBe("grok");
    expect(s.id).toBe("a1b2c3d4-1");
    expect(s.title).toBe("Module list");
    expect(s.cwd).toBe("E:\\work\\x");
    expect(s.model).toBe("grok-4.6 · reasoning high");
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "List the modules"],
      ["assistant", "Reading the docs first.\n\nConclusion: three modules."],
    ]);
    expect([...s.turns[1].tools.entries()]).toEqual([
      ["read_file", 2],
      ["web_search", 1],
    ]);
    const md = renderMarkdown(s);
    expect(md).toContain("- source: grok · id `a1b2c3d4-1`");
    expect(md).toContain("- model: grok-4.6 · reasoning high");
    expect(md).not.toContain("secret output");
    expect(md).not.toContain("You are Grok");
    expect(md).toContain("> [tools] read_file ×2 · web_search");
    expect(suggestFileName(s)).toMatch(/^20260904-\d{4}-a1b2c3d4-Module-list\.md$/);
  });

  it("agy: unwraps USER_REQUEST, drops USER_SETTINGS_CHANGE, PLANNER_RESPONSE is a turn, GENERIC folds as a tool step, SYSTEM is dropped; id / cwd from meta", () => {
    const raw = [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-09-04T10:36:00Z",
        content: "<USER_REQUEST>\nExplain the build\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nlocale xx\n</USER_SETTINGS_CHANGE>",
      }),
      JSON.stringify({ step_index: 1, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-09-04T10:37:00Z", content: "folder listing..." }),
      JSON.stringify({ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-09-04T10:38:00Z", content: "The build has two steps." }),
      JSON.stringify({ step_index: 3, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-09-04T10:39:00Z", content: "server restart" }),
    ].join("\n");
    expect(detectFormat(raw)).toBe("antigravity");
    const s = parseSession(raw, "antigravity", { meta: { id: "b2c3d4e5-c", cwd: "E:\\work\\y" } });
    expect(s.source).toBe("agy");
    expect(s.id).toBe("b2c3d4e5-c");
    expect(s.cwd).toBe("E:\\work\\y");
    expect(s.startedAt).toBe("2026-09-04T10:36:00Z");
    expect(s.endedAt).toBe("2026-09-04T10:39:00Z");
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "Explain the build"],
      ["assistant", "The build has two steps."],
    ]);
    expect([...s.turns[1].tools.entries()]).toEqual([["tool step", 1]]);
    expect(s.title).toBe("Explain the build");
    const md = renderMarkdown(s);
    expect(md).not.toContain("server restart");
    expect(md).not.toContain("locale xx");
  });

  it("cursor: unwraps timestamp / user_query and parses the time, folds tool_use, tool_result-only user records and turn_ended make no turn; meta fills the cwd", () => {
    const raw = [
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "<timestamp>Monday, Sep 7, 2026, 10:00 AM (UTC-5)</timestamp>\n<user_query>\nApply two small fixes\n</user_query>" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "Reading the files." },
            { type: "tool_use", name: "Read", input: {} },
            { type: "tool_use", name: "Read", input: {} },
          ],
        },
      }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "tool_use", name: "Shell", input: { command: "pnpm test" } }] } }),
      JSON.stringify({ role: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "output" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Done." }] } }),
      JSON.stringify({ type: "turn_ended", status: "success" }),
    ].join("\n");
    expect(detectFormat(raw)).toBe("cursor");
    const s = parseSession(raw, "cursor", { meta: { id: "c3d4e5f6-d", cwd: "D:\\sample-app", startedAt: "2026-09-04T00:00:00.000Z" } });
    expect(s.source).toBe("cursor");
    expect(s.cwd).toBe("D:\\sample-app");
    // A timestamp parsed from the text wins over meta
    expect(s.startedAt).toBe("2026-09-07T15:00:00.000Z");
    expect(s.turns[0].at).toBe("2026-09-07T15:00:00.000Z");
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "Apply two small fixes"],
      ["assistant", "Reading the files.\n\nDone."],
    ]);
    expect([...s.turns[1].tools.entries()]).toEqual([
      ["Read", 2],
      ["Shell", 1],
    ]);
    expect(renderMarkdown(s)).not.toContain("<timestamp>");
  });
});

describe("project folders (sessions/imported/<project>/)", () => {
  const win = { home: "C:\\Users\\me", tmpDir: "C:\\Users\\me\\AppData\\Local\\Temp" };
  const mac = { home: "/Users/me", tmpDir: "/var/folders/xy/T" };

  it("project level: first level below a drive or the home directory, one more below containers; worktrees go back to the main repository", () => {
    expect(projectBucket("D:\\sample-app\\apps\\web", win)).toBe("sample-app");
    expect(projectBucket("D:\\sample-app\\.claude\\worktrees\\calm-lovelace-a1b2c3", win)).toBe("sample-app");
    expect(projectBucket("C:\\Users\\me\\Desktop\\notes-app\\tmp", win)).toBe("notes-app");
    expect(projectBucket("C:\\Users\\me\\OneDrive\\Desktop\\Reports", win)).toBe("Reports");
    expect(projectBucket(`C:\\Users\\me\\${cjk(0x684c, 0x9762)}\\drafts`, win)).toBe("drafts"); // Desktop in Chinese
    expect(projectBucket("/Users/me/code/longkeep/src", mac)).toBe("longkeep");
    expect(projectBucket("/Volumes/Ext/proj/a", mac)).toBe("proj");
    expect(projectBucket("D:\\steam\\steamapps\\common\\Some Game\\SomeGame_Data", win)).toBe("Some-Game");
  });

  it("prefers the git root (detection injected by the caller), except when the home directory itself is a repository", () => {
    const gitRoot = (p: string) =>
      p.toLowerCase().startsWith("d:\\work\\client\\app") ? "D:\\work\\client\\app" : p.startsWith("C:\\Users\\me") ? "C:\\Users\\me" : null;
    expect(projectBucket("D:\\work\\client\\app\\src", { ...win, gitRoot })).toBe("app");
    expect(projectBucket("D:\\work\\other", { ...win, gitRoot })).toBe("work");
    expect(projectBucket("C:\\Users\\me\\Desktop\\notes-app", { ...win, gitRoot })).toBe("notes-app");
  });

  it("special folders: delegation working folders, temp folders, drive roots / home / app data, no cwd", () => {
    expect(projectBucket("C:\\Users\\me\\.longkeep\\runs\\proj-1a2b3c4d\\20261001-085130-demo\\work", win)).toBe(BUCKET_DELEGATION);
    expect(projectBucket("/Users/me/.longkeep/runs/proj-1a2b3c4d/20261001-085130-demo/work", mac)).toBe(BUCKET_DELEGATION);
    expect(projectBucket("/data/of-home/runs/proj-1a2b3c4d/job/work", { ...mac, runsDir: "/data/of-home/runs" })).toBe(BUCKET_DELEGATION);
    expect(projectBucket("C:\\Users\\me\\AppData\\Local\\Temp\\claude\\D--x\\s\\scratchpad", win)).toBe(BUCKET_TEMP);
    expect(projectBucket("/var/folders/xy/T/run", mac)).toBe(BUCKET_TEMP);
    expect(projectBucket("/tmp/x", mac)).toBe(BUCKET_TEMP);
    expect(projectBucket("D:\\", win)).toBe(BUCKET_MISC);
    expect(projectBucket("E:", win)).toBe(BUCKET_MISC);
    expect(projectBucket("C:\\Users\\me", win)).toBe(BUCKET_MISC);
    expect(projectBucket("C:\\Users\\me\\Desktop", win)).toBe(BUCKET_MISC);
    expect(projectBucket("C:\\Users\\me\\AppData\\Local\\Packages\\Claude_x\\LocalCache", win)).toBe(BUCKET_MISC);
    expect(projectBucket("C:\\Users\\me\\Documents\\Codex\\2026-09-04\\sample", win)).toBe(BUCKET_MISC);
    expect(projectBucket("C:\\Users\\me\\.codex\\worktrees\\abc", win)).toBe(BUCKET_MISC);
    expect(projectBucket("/Users/me/Library/Application Support/Claude/x", mac)).toBe(BUCKET_MISC);
    expect(projectBucket(null, win)).toBe(BUCKET_UNKNOWN);
    expect(projectBucket("  ", win)).toBe(BUCKET_UNKNOWN);
  });

  it("folder-name cleanup: Windows-invalid characters, leading / trailing dots and spaces, device names, length", () => {
    expect(sanitizeBucket('a<b>:c"d|e?f*g')).toBe("a-b-c-d-e-f-g");
    expect(sanitizeBucket(" .hidden. ")).toBe("hidden");
    expect(sanitizeBucket("CON")).toBe("_CON");
    expect(sanitizeBucket("nul.txt")).toBe("_nul.txt");
    expect(sanitizeBucket("..")).toBe("");
    expect(sanitizeBucket("x".repeat(80))).toHaveLength(60);
    expect(projectBucket("D:\\..\\..", win)).toBe(BUCKET_MISC);
  });

  it("recognises a delegated session by the runner's first prompt line in one of the first user messages", () => {
    const turn = (role: Turn["role"], text: string): Turn => ({ role, at: null, text, tools: new Map(), agents: [] });
    expect(isDelegationSession({ turns: [turn("user", "<environment_context>..."), turn("user", `${DELEGATION_PROMPT_FIRST_LINE}\n\nExecutor: codex.`)] })).toBe(true);
    expect(isDelegationSession({ turns: [turn("user", "have a look at this"), turn("assistant", DELEGATION_PROMPT_FIRST_LINE)] })).toBe(false);
  });

  it("title: skips injected blocks; a delegated session takes the record's task name or the line under the task heading", () => {
    const codex = (texts: string[], cwd = "/w") =>
      [
        JSON.stringify({ type: "session_meta", timestamp: "2026-10-01T08:00:00Z", payload: { id: "c1", cwd } }),
        ...texts.map((text) =>
          JSON.stringify({ type: "response_item", timestamp: "2026-10-01T08:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }),
        ),
      ].join("\n");
    expect(parseSession(codex(["<environment_context>\n<cwd>/w</cwd>", "Rename the config loader"]), "codex").title).toBe("Rename the config loader");
    expect(parseSession(codex(["# AGENTS.md instructions for D:\\x\n...", "Fix the login"]), "codex").title).toBe("Fix the login");
    const prompt = `${DELEGATION_PROMPT_FIRST_LINE}\nWorking folder: /w.\n\n${DELEGATION_TASK_HEADING}\nCount the words in the readme`;
    expect(parseSession(codex([prompt]), "codex").title).toBe("Count the words in the readme");
    const followUp = `${DELEGATION_PROMPT_FIRST_LINE}\n\n${DELEGATION_FOLLOW_UP_HEADING}\nNow also print them`;
    expect(parseSession(codex([followUp]), "codex").title).toBe("Now also print them");
    expect(parseSession(codex([prompt], "/Users/me/.longkeep/runs/w-1a2b3c4d/20260101-000000-demo/work"), "codex").title).toBe("demo");
    expect(parseSession(codex([], "/w"), "codex").title).toBe("Untitled session");
  });

  it("codex compaction: user messages missing from the body are added at the start (with the session start time), injected blocks and existing messages are not, ordinary messages stay verbatim", () => {
    const raw = [
      JSON.stringify({ type: "session_meta", timestamp: "2026-07-14T09:40:00Z", payload: { id: "sub1", cwd: "/w", agent_path: "/root/worker" } }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-14T09:40:30Z",
        payload: { type: "agent_message", author: "/root", recipient: "/root/worker", content: [{ type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/worker" }] },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-14T09:41:00Z",
        payload: { type: "agent_message", author: "/root/worker", recipient: "/root", content: [{ type: "input_text", text: "report back" }] },
      }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-14T09:42:00Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Starting work" }] } }),
      JSON.stringify({
        type: "compacted",
        timestamp: "2026-07-14T10:00:00Z",
        payload: {
          replacement_history: [
            { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>" }] },
            { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<current_date>2026-07-14</current_date>" }] },
            { type: "message", role: "user", content: [{ type: "input_text", text: "List the affected files first" }] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "Starting work" }] },
          ],
        },
      }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-14T10:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "go on" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-14T10:02:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "go on" }] } }),
    ].join("\n");
    const s = parseSession(raw, "codex");
    expect(s.turns.map((t) => [t.role, t.text.split("\n")[0]])).toEqual([
      ["user", "List the affected files first"],
      ["user", "[task from /root]"],
      ["assistant", "Starting work"],
      ["user", "go on"],
      ["user", "go on"],
    ]);
    expect(s.turns[0].at).toBe("2026-07-14T09:40:00Z");
  });

  it("checksum line: untouched → true, CRLF is no change, one changed character → false, no line → null", () => {
    const md = "# Session: x\n\n- source: codex · id `a`\n- imported: 2026-10-09 10:00 · original transcript: `/p`\n\n---\n\n## User\n\nbody\n";
    const sealed = withChecksum(md);
    expect(sealed).toMatch(/^- imported: .*\n- checksum: sha256:[0-9a-f]{16}\n/m);
    expect(archiveUntouched(sealed)).toBe(true);
    expect(archiveUntouched(sealed.replace(/\n/g, "\r\n"))).toBe(true);
    expect(archiveUntouched(sealed.replace("body", "bodY"))).toBe(false);
    expect(archiveUntouched(md)).toBeNull();
    expect(archiveChecksum(sealed)).toBe(archiveChecksum(md));
  });
});
