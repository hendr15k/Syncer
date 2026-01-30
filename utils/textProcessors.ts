/**
 * Splits a long string of text into manageable chunks for TTS processing.
 * Keeps chunks around 1200-1500 characters to balance latency and context.
 * respecting paragraph breaks and sentence endings.
 */
export function chunkText(text: string, maxChunkSize: number = 1500): string[] {
  if (!text) return [];
  
  // Pre-clean text:
  // 1. Unify newlines
  // 2. Remove multiple spaces
  // 3. Remove standalone page numbers (common in PDFs like "Page 12")
  let cleanText = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ');

  if (cleanText.length <= maxChunkSize) return [cleanText];

  const chunks: string[] = [];
  // Split by double newlines to preserve paragraphs
  const paragraphs = cleanText.split(/\n\s*\n/);
  
  let currentChunk = "";

  for (const paragraph of paragraphs) {
    const cleanParagraph = paragraph.trim();
    if (!cleanParagraph) continue; 

    // Heuristic: If a "paragraph" is very short and looks like a page number or header, merge it or ignore it?
    // For now, we keep it but ensure we don't create tiny chunks unnecessarily.

    // If adding this paragraph exceeds max size
    if (currentChunk.length + cleanParagraph.length > maxChunkSize) {
      // Flush current chunk if meaningful
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }

      // If the paragraph ITSELF is huge, split by sentences
      if (cleanParagraph.length > maxChunkSize) {
        // Regex Lookahead explanation:
        // Split after [.!?] followed by whitespace or end of string.
        // We capture the delimiter to keep it attached to the sentence if possible, but JS split captures are tricky.
        // Instead, we use match.
        // Match sequence of non-terminators, then terminators, then whitespace.
        const sentences = cleanParagraph.match(/[^.!?\n]+[.!?\n]+(\s+|$)/g);
        
        if (!sentences) {
            // Fallback if no sentence structure found (giant blob of text)
            // Just hard chop at maxChunkSize
            let remaining = cleanParagraph;
            while(remaining.length > 0) {
                chunks.push(remaining.slice(0, maxChunkSize));
                remaining = remaining.slice(maxChunkSize);
            }
        } else {
            for (const sentence of sentences) {
               if (currentChunk.length + sentence.length > maxChunkSize) {
                  if (currentChunk.trim().length > 0) chunks.push(currentChunk.trim());
                  currentChunk = sentence;
               } else {
                  currentChunk += sentence;
               }
            }
        }
      } else {
        currentChunk = cleanParagraph;
      }
    } else {
      currentChunk += (currentChunk ? "\n\n" : "") + cleanParagraph;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  // Final sanity check: 
  // 1. Filter out empty chunks
  // 2. Filter out chunks with NO alphanumeric characters (e.g. just "..." or " - ")
  return chunks.filter(c => c.trim().length > 0 && /[a-zA-Z0-9äöüÄÖÜß]/.test(c));
}