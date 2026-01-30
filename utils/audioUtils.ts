// Function to decode Base64 string to Uint8Array
export function decodeBase64(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Function to decode audio data.
// Handles both raw PCM (from Gemini Live API) and WAV/MP3 containers (from REST/generateContent).
export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 24000,
  numChannels: number = 1,
): Promise<AudioBuffer> {
  // Strategy 1: Browser Native Decoder
  // This supports WAV, MP3, OGG, AAC, etc.
  try {
      // We must copy the buffer because decodeAudioData detaches/neuteres the array buffer
      // and we might need the original data for the fallback if it fails (though unlikely for valid container formats).
      // However, if decodeAudioData fails, it usually throws.
      const bufferCopy = data.buffer.slice(0);
      return await ctx.decodeAudioData(bufferCopy);
  } catch (nativeError) {
      // Strategy 2: Raw PCM Fallback
      // If native decoding fails (e.g. "Unable to decode audio data"), it's likely raw PCM 
      // which has no header. Gemini Live API often sends this.
      
      // console.warn("Native decode failed, falling back to PCM", nativeError);

      const alignedBuffer = new ArrayBuffer(data.byteLength);
      const alignedView = new Uint8Array(alignedBuffer);
      alignedView.set(data);

      // If odd length, ignore the last byte to align with Int16
      const length = data.byteLength - (data.byteLength % 2);
      const dataInt16 = new Int16Array(alignedBuffer, 0, length / 2);
      
      const frameCount = dataInt16.length / numChannels;
      if (frameCount === 0) {
          throw new Error("Audio buffer is empty after PCM processing");
      }

      const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

      for (let channel = 0; channel < numChannels; channel++) {
        const channelData = buffer.getChannelData(channel);
        for (let i = 0; i < frameCount; i++) {
          // Normalize 16-bit integer to float [-1.0, 1.0]
          channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
        }
      }
      return buffer;
  }
}

// Helper to format time in MM:SS
export function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}