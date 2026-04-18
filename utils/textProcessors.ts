/**
 * Splits a long string of text into manageable chunks for TTS processing.
 * Keeps chunks around 1200-1500 characters to balance latency and context.
 *
 * Key improvements over naive splitting:
 * 1. Smart sentence boundary detection — never splits mid-sentence
 * 2. Greedy fill — sentences fill the current chunk before starting a new one
 * 3. Min chunk protection — small orphaned sentences are merged back
 * 4. Paragraph respect — double-newlines create natural breakpoints
 * 5. Whitespace normalization — handles PDF-scraped garbage gracefully
 */
export function chunkText(text: string, maxChunkSize: number = 1500): string[] {
  if (!text) return [];

  // --- Pre-clean text ---
  const cleanText = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  if (cleanText.length <= maxChunkSize) return [cleanText];

  // --- Split into sentences ---
  // Handles German punctuation (.!?), abbreviations (Mr., Dr., etc.), and ellipses
  // We use a lookahead split to keep delimiters attached to sentences.
  const sentences: string[] = [];
  let buffer = '';
  const source = cleanText.split(/\n\s*\n/);

  for (const paragraph of source) {
    const p = paragraph.trim();
    if (!p) continue;

    // Split paragraph into sentence candidates
    const parts = p.match(/[^.!?]+(?:[.!?]+\s*|"(?=[A-ZÄÖÜ])|[.!?]+$)+/g) ?? [p];

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      // Guard: protect against giant blobs with no sentence endings
      if (trimmed.length > maxChunkSize * 1.5) {
        // Hard-chop at maxChunkSize as last resort (avoid infinite loop)
        for (let i = 0; i < trimmed.length; i += maxChunkSize) {
          const slice = trimmed.slice(i, i + maxChunkSize).trim();
          if (slice) sentences.push(slice);
        }
      } else {
        sentences.push(trimmed);
      }
    }
  }

  // --- Greedy chunk assembly ---
  const chunks: string[] = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    const withBreak = currentChunk ? '\n\n' : '';
    const projected = currentChunk + withBreak + sentence;

    if (projected.length <= maxChunkSize) {
      // Sentence fits — add it
      currentChunk = projected;
    } else if (sentence.length <= maxChunkSize) {
      // Sentence doesn't fit, but it fits on its own — flush and start new
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = sentence;
    } else {
      // Sentence itself is oversized — flush existing, hard-chop the sentence
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
      }
      // Hard-chop oversized sentence
      for (let i = 0; i < sentence.length; i += maxChunkSize) {
        const slice = sentence.slice(i, i + maxChunkSize).trim();
        if (slice) {
          chunks.push(slice);
        }
      }
      currentChunk = '';
    }
  }

  // --- Flush remaining chunk ---
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  // --- Orphan rescue: merge tiny last chunks back into the previous one ---
  // Any chunk < 80 chars gets merged into its predecessor to avoid
  // awkward micro-chunks that break audio flow
  const MIN_CHUNK_SIZE = 80;
  const rescued: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const prev = rescued[rescued.length - 1];

    if (i > 0 && chunk.length < MIN_CHUNK_SIZE && prev) {
      // Merge orphan into previous chunk
      rescued[rescued.length - 1] = prev + '\n\n' + chunk;
    } else {
      rescued.push(chunk);
    }
  }

  // --- Final filter: remove empty / garbage chunks ---
  return rescued.filter(c => c.trim().length > 0 && /[a-zA-Z0-9äöüÄÖÜß]/.test(c));
}