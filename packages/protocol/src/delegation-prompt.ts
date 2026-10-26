/**
 * Marker strings that the delegate module writes and the sessions module recognises. They are data, not labels:
 * changing one means transcripts written before the change are no longer recognised.
 *
 * - The delegation runner starts every prompt it sends to an executor with DELEGATION_PROMPT_FIRST_LINE, and puts
 *   the brief under DELEGATION_TASK_HEADING (first round) or DELEGATION_FOLLOW_UP_HEADING (later rounds), the
 *   heading alone on its line and the brief on the next line.
 * - The session importer uses them to file such sessions under `_delegated` and to take their title from the brief.
 */

/** First line of every prompt the delegation runner sends. */
export const DELEGATION_PROMPT_FIRST_LINE = "You are working on a task delegated through OpenAgent.";

/** Heading line of the brief in a first-round delegation prompt. */
export const DELEGATION_TASK_HEADING = "Task:";

/** Heading line of the brief in a follow-up round. */
export const DELEGATION_FOLLOW_UP_HEADING = "Task for this round (continues the previous one):";
