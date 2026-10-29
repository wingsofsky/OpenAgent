/**
 * CriticMarkup suggestions: the one mark Longkeep writes.
 *
 * Plain text: a suggestion lives inline in the document, so any editor, agent or `cat`
 * can read it, and keeping or deleting it is a plain edit of the file. Longkeep writes an insertion tagged with the executor's name, standard
 * CriticMarkup with an author extension: `{++@grok: new text++}`, where the content starting with `@name:` names the
 * author. A delegation's writeback appends one to the handbook (cli handbook/handbook.ts), and the ones still in it are
 * counted as waiting for a decision (executors.ts countPendingSuggestions).
 */

export const makeCritic = {
  ins: (text: string, author?: string) => `{++${author ? `@${author}: ` : ""}${text}++}`,
};
