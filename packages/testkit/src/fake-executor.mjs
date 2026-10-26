/**
 * Fake executor for tests: imitates the headless interface of the five built-in CLIs.
 *   codex shape: argv[0] === "exec" (argv[1] === "resume" for a follow-up round), honours -o <file>, stdout imitates
 *                the header and footer of codex exec ("session id: …" and "tokens used\n12")
 *   agy / grok / cursor / claude shape: -p <prompt>, stdout is a JSON answer (session_id = the value of -s /
 *                --session-id, in follow-up rounds the value of --resume / --conversation; plus usage, the argv it
 *                received and its actual cwd)
 * Answer = "fake answer: " + the last line of the prompt (the runner puts its preamble first, so the last line is the
 * task itself); follow-up rounds of the codex shape are prefixed "resumed: ".
 * Controls: FAKE_EXEC_FAIL=1 → exit code 3; FAKE_EXEC_FAIL_ONCE=1 → exit code 5 the first time in this cwd, normal
 *   afterwards; FAKE_EXEC_SLEEP_MS → sleep first (no output, to test stalls); FAKE_EXEC_EMPTY=1 → empty answer;
 *   FAKE_EXEC_WRITE=<name> → write a file into the cwd; FAKE_EXEC_TOKENS=<n> → "tokens used" of the codex shape
 *   (default 12); FAKE_EXEC_TRACEPARENT_OUT=<absolute path> → append the TRACEPARENT it received to that file
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const sleep = Number(process.env.FAKE_EXEC_SLEEP_MS ?? 0);
if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
if (process.env.FAKE_EXEC_TRACEPARENT_OUT) fs.appendFileSync(process.env.FAKE_EXEC_TRACEPARENT_OUT, `${process.env.TRACEPARENT ?? ""}\n`);
if (process.env.FAKE_EXEC_WRITE) fs.writeFileSync(path.join(process.cwd(), process.env.FAKE_EXEC_WRITE), "artifact\n");
if (process.env.FAKE_EXEC_FAIL === "1") {
  console.error("boom: the fake executor fails on purpose");
  process.exit(3);
}
if (process.env.FAKE_EXEC_FAIL_ONCE === "1") {
  const marker = path.join(process.cwd(), ".fake-tried");
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, "1");
    console.error("transient: fails on purpose the first time");
    process.exit(5);
  }
}
const at = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const isCodex = argv[0] === "exec";
const isResume = isCodex && argv[1] === "resume";
const prompt = isCodex ? argv[argv.length - 1] : (at("-p") ?? "");
const lastLine = prompt.trim().split(/\r?\n/).pop() ?? "";
const answer = process.env.FAKE_EXEC_EMPTY === "1" ? "" : `${isResume ? "resumed: " : ""}fake answer: ${lastLine}`;
// Echo the arguments (without the prompt itself) so tests can check flags
const argvShown = argv.map((a) => (a === prompt ? "<prompt>" : a));
if (isCodex) {
  const out = at("-o");
  if (out) fs.writeFileSync(out, answer);
  console.log(
    `OpenAI Codex v0.0.0-fake\n--------\nworkdir: ${process.cwd()}\nsession id: 11111111-2222-3333-4444-555555555555\nargv: ${argvShown.join(" ")}\n--------\nuser\n${prompt.slice(0, 20)}\ncodex\n${answer}\ntokens used\n${process.env.FAKE_EXEC_TOKENS ?? 12}\n${answer}`,
  );
} else {
  const session = at("-s") ?? at("--session-id") ?? at("--resume") ?? at("--conversation") ?? "fake-session";
  console.log(JSON.stringify({ type: "result", result: answer, session_id: session, usage: { input_tokens: 30, output_tokens: 12 }, argv: argvShown, cwd: process.cwd() }));
}
