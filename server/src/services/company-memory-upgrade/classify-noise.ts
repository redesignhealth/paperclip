/**
 * Deterministic memory noise classification (TECH-8191).
 *
 * Classifies whether a memory entry is obvious noise that should not be converted
 * or published to the upgraded memory collection.
 *
 * Architectural Invariant:
 * This function must be conservative and free of I/O.
 * It must NEVER classify a substantive preference, decision, fact, or instruction as noise.
 */

const EXACT_NOISE_TOKENS = new Set([
  // Bare greetings & acknowledgments
  "hi",
  "hey",
  "hello",
  "hello world",
  "hello there",
  "good morning",
  "good afternoon",
  "good evening",
  "good night",
  "thanks",
  "thank you",
  "thank you so much",
  "ok",
  "okay",
  "sounds good",
  "got it",
  "understood",
  "ack",
  "noted",
  "bye",
  "goodbye",
  "see you",
  "cya",
  "yes",
  "no",
  "yep",
  "nope",

  // Test / placeholder strings
  "test",
  "testing",
  "test note",
  "test memory",
  "test data",
  "test 123",
  "placeholder",
  "dummy",
  "dummy note",
  "sample",
  "sample note",
  "sample text",
  "lorem ipsum",
  "lorem ipsum dolor sit amet",
  "asdf",
  "qwerty",
  "foo",
  "bar",
  "baz",
  "foobar",
  "n/a",
  "na",
  "null",
  "nil",
  "undefined",
  "nothing",
  "ping",
  "pong",
]);

/**
 * Normalizes text for noise evaluation: trims whitespace and punctuation, lowercases.
 */
function normalizeForNoiseCheck(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[\s.,!?;:()\[\]{}"'`~_-]+|[\s.,!?;:()\[\]{}"'`~_-]+$/g, "")
    .replace(/\s+/g, " ");
}

export interface NoiseClassificationResult {
  isNoise: boolean;
  reason?: "empty" | "exact_placeholder_or_greeting";
}

/**
 * Returns detailed classification for diagnostic inspection.
 */
export function classifyMemoryNoiseDetailed(
  text: string | null | undefined,
): NoiseClassificationResult {
  if (text === null || text === undefined) {
    return { isNoise: true, reason: "empty" };
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { isNoise: true, reason: "empty" };
  }

  const normalized = normalizeForNoiseCheck(trimmed);

  // Explicit empty-after-normalization rule (e.g. " . " or "---" stays noise)
  if (normalized.length === 0) {
    return { isNoise: true, reason: "empty" };
  }

  if (EXACT_NOISE_TOKENS.has(normalized)) {
    return { isNoise: true, reason: "exact_placeholder_or_greeting" };
  }

  return { isNoise: false };
}

/**
 * Pure function: returns true if the memory text is deterministically noise.
 */
export function classifyMemoryNoise(text: string | null | undefined): boolean {
  return classifyMemoryNoiseDetailed(text).isNoise;
}
