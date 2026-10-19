// Keep the public answer schema and coordinator-side work limits aligned.
// A single answer keeps the normal task-text bound; a batch may not multiply it.
export const MAX_ANSWER_COUNT = 100;
// The earlier in-process service could accept every question in a 128-item
// planner output as one answer operation; only new operations use the lower cap.
export const MAX_LEGACY_ANSWER_COUNT = 128;
export const MAX_ANSWER_CHARACTERS = 32 * 1024;
export const MAX_ANSWER_BYTES = 32 * 1024;
// Prior releases bounded each answer and ID individually but not their batch.
// This is the largest aggregate that could have passed those checks, so exact
// stored-operation retries remain compatible without reopening unbounded hashes.
export const MAX_ANSWER_ID_CHARACTERS = 128;
export const MAX_LEGACY_ANSWER_BATCH_BYTES = MAX_LEGACY_ANSWER_COUNT * (MAX_ANSWER_CHARACTERS + MAX_ANSWER_ID_CHARACTERS);
