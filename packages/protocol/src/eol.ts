/**
 * Line-ending kernel (pure logic, shared by every reader and writer; no DOM or Node dependencies).
 *
 * On Windows, Git for Windows defaults to core.autocrlf=true, so users' files are often checked out with CRLF; a file
 * saved in Notepad may be CRLF too. The rule: reading always tolerates `\r\n`; writing keeps the file's existing style.
 * Never mix LF into a CRLF file, and never turn an LF file into CRLF.
 */

export type Eol = "\n" | "\r\n";

/** The dominant line ending of a text: CRLF only when there are more CRLF than bare LF; no line break means LF. */
export function detectEol(text: string): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
}

/** Converts every line break (`\r\n` or `\n`) to eol; a lone `\r` is left alone. */
export function withEol(text: string, eol: Eol): string {
  return eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
}
