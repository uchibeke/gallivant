// Keep the public answer schema and coordinator-side work limits aligned.
// A single answer keeps the normal task-text bound; a batch may not multiply it.
export const MAX_ANSWER_COUNT = 100;
export const MAX_ANSWER_CHARACTERS = 32 * 1024;
export const MAX_ANSWER_BYTES = 32 * 1024;
