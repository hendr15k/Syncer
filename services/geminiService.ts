import { GoogleGenAI, Modality, Type } from "@google/genai";
import { VoiceName, AVAILABLE_VOICES, TTSModel } from "../types";
import { audioCache } from "../utils/cache";

// --- Configuration ---

// Mapping of internal VoiceNames to Google Cloud TTS Voice IDs (German / de-DE)
// This ensures that "Puck" or "Kore" maps to a real voice for EVERY Google model type.
const GOOGLE_TTS_VOICE_MAP: Record<string, Record<VoiceName, string>> = {
  [TTSModel.Google_Neural2]: {
    // Neural2 German Voices: A(F), B(M), C(F), D(M), F(F)
    [VoiceName.Kore]: 'de-DE-Neural2-C',   // Female, Soft
    [VoiceName.Puck]: 'de-DE-Neural2-D',   // Male, Generic
    [VoiceName.Charon]: 'de-DE-Neural2-B', // Male, Deep
    [VoiceName.Fenrir]: 'de-DE-Neural2-D', // Reuse D (limited male options)
    [VoiceName.Zephyr]: 'de-DE-Neural2-A', // Female, Bright
  },
  [TTSModel.Google_WaveNet]: {
    // WaveNet German Voices: A(F), B(M), C(F), D(M), E(M), F(F)
    [VoiceName.Kore]: 'de-DE-Wavenet-C',
    [VoiceName.Puck]: 'de-DE-Wavenet-D',
    [VoiceName.Charon]: 'de-DE-Wavenet-B',
    [VoiceName.Fenrir]: 'de-DE-Wavenet-E',
    [VoiceName.Zephyr]: 'de-DE-Wavenet-A',
  },
  [TTSModel.Google_Chirp]: {
    // Studio Voices (High Quality - Studio)
    [VoiceName.Kore]: 'de-DE-Studio-C', 
    [VoiceName.Puck]: 'de-DE-Studio-B', 
    [VoiceName.Charon]: 'de-DE-Studio-B', 
    [VoiceName.Fenrir]: 'de-DE-Studio-B', 
    [VoiceName.Zephyr]: 'de-DE-Studio-C', 
  }
};

// --- Helpers for Audio Processing ---

function decodeBase64(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function concatAudioBuffers(buffers: Uint8Array[]): Uint8Array {
  const silenceLen = 4800; // 0.2s silence at 24kHz
  const silence = new Uint8Array(silenceLen); 

  const processedBuffers = buffers.map(b => {
    if (b.length % 2 !== 0) {
        const padded = new Uint8Array(b.length + 1);
        padded.set(b);
        return padded;
    }
    return b;
  });

  const totalLen = processedBuffers.reduce((acc, b, i) => acc + b.length + (i < processedBuffers.length - 1 ? silenceLen : 0), 0);
  const result = new Uint8Array(totalLen);
  
  let offset = 0;
  processedBuffers.forEach((b, i) => {
    result.set(b, offset);
    offset += b.length;
    if (i < processedBuffers.length - 1) {
      result.set(silence, offset);
      offset += silenceLen;
    }
  });
  
  return result;
}

// --- Request Queue for Rate Limiting & Backoff ---

class RequestQueue {
  private queue: Array<{task: () => Promise<void>, reject: (reason?: any) => void}> = [];
  private activeCount = 0;
  private maxConcurrent = 1; 
  private minInterval = 1000; // Reduced slighly as 3-Flash is faster
  private lastRequestTime = 0;
  private backoffUntil = 0;

  add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        task: async () => {
          try {
            const result = await task();
            resolve(result);
          } catch (error: any) {
             const msg = (error.message || JSON.stringify(error)).toLowerCase();
             if (msg.includes('429') || msg.includes('quota') || msg.includes('resource_exhausted')) {
                 console.warn("Rate limit detected. Backing off...");
                 this.backoffUntil = Date.now() + 5000;
             }
            reject(error);
          }
        },
        reject
      });
      this.process();
    });
  }

  clear() {
    this.queue.forEach(item => item.reject(new Error("Request cancelled by user navigation")));
    this.queue = [];
  }

  private async process() {
    if (this.activeCount >= this.maxConcurrent) return;
    if (this.queue.length === 0) return;

    if (Date.now() < this.backoffUntil) {
        const waitTime = this.backoffUntil - Date.now();
        setTimeout(() => this.process(), waitTime + 100);
        return;
    }

    const now = Date.now();
    const timeSinceLast = now - this.lastRequestTime;
    
    if (timeSinceLast < this.minInterval) {
        setTimeout(() => this.process(), this.minInterval - timeSinceLast);
        return;
    }

    const item = this.queue.shift();
    if (item) {
        this.activeCount++;
        this.lastRequestTime = Date.now();
        
        item.task().finally(() => {
            this.activeCount--;
            this.process();
        });
    }
  }
}

const apiQueue = new RequestQueue();

export function cancelGenerations() {
    apiQueue.clear();
}

// --- Retry Logic ---

async function withRetry<T>(operation: () => Promise<T>, retries = 3, baseDelay = 1000): Promise<T> {
  let lastError: any;
  
  for (let i = 0; i < retries; i++) {
    try {
      return await operation();
    } catch (err: any) {
      lastError = err;
      
      let msg = "";
      if (typeof err === 'string') msg = err;
      else if (err.message) msg = err.message;
      else try { msg = JSON.stringify(err); } catch {}
      
      msg = msg.toLowerCase();

      const isRateLimit = 
        msg.includes('429') || 
        (err.status === 429) || 
        msg.includes('quota') || 
        msg.includes('resource_exhausted');

      const isServerOverload = err.status === 503;

      if ((isRateLimit || isServerOverload) && i < retries - 1) {
        const delay = (baseDelay * Math.pow(2, i + 1)) + (Math.random() * 500);
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

// --- Voice Assignment Logic ---

function getVoiceForSpeaker(speakerName: string, narratorVoiceName: VoiceName): VoiceName {
  const name = speakerName.trim().toLowerCase();
  
  // German keywords for narrator
  if (name === 'narrator' || name === 'erzähler' || name === 'erzaehler' || name === 'erzählerin') return narratorVoiceName;

  const available = AVAILABLE_VOICES.filter(v => v.name !== narratorVoiceName);
  if (available.length === 0) return narratorVoiceName;

  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  const index = Math.abs(hash) % available.length;
  return available[index].name;
}

// --- API Keys ---

function getGeminiKey(): string {
  const key = process.env.API_KEY;
  if (!key) {
      throw new Error("Gemini API Key fehlt. Bitte setzen Sie process.env.API_KEY.");
  }
  return key;
}

function getCloudTTSKey(): string {
  // Publicly available key for demo purposes (Google Cloud TTS)
  return "AIzaSyAM0dQmnvUSgNMKbuFQ29c7bBjrbsjr-pM";
}

// --- Raw Generation Functions (No Queue) ---

async function generateGeminiAudioRaw(text: string, voice: VoiceName, model: string): Promise<Uint8Array> {
  const ai = new GoogleGenAI({ apiKey: getGeminiKey() });
  const response = await ai.models.generateContent({
    model: model, // Accepts Gemini 2.5 TTS
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice },
        },
      },
    },
  });

  const base64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64) {
    if (response.promptFeedback?.blockReason) {
      throw new Error(`Blockiert: ${response.promptFeedback.blockReason}`);
    }
    throw new Error("Leere Audio-Antwort von der Gemini API");
  }
  return decodeBase64(base64);
}

async function generateStandardGoogleTTSRaw(text: string, voice: VoiceName, model: string): Promise<Uint8Array> {
  const key = getCloudTTSKey();

  // 1. Identify which map to use based on the Model Type
  let modelMap = GOOGLE_TTS_VOICE_MAP[model];
  
  // Fallback: If map not found (should not happen with correct Types), default to Neural2
  if (!modelMap) {
      console.warn(`Kein Mapping für Modell ${model} gefunden, nutze Neural2`);
      modelMap = GOOGLE_TTS_VOICE_MAP[TTSModel.Google_Neural2];
  }

  // 2. Map the generic voice name (e.g. "Puck") to the specific Cloud ID (e.g. "de-DE-Wavenet-D")
  const cloudVoiceName = modelMap[voice] || 'de-DE-Neural2-C';

  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`;
  
  const payload = {
    input: { text: text },
    voice: { languageCode: 'de-DE', name: cloudVoiceName }, 
    audioConfig: { 
      audioEncoding: 'LINEAR16', 
      sampleRateHertz: 24000 
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    if (response.status === 400 && errorBody.includes("API_KEY_INVALID")) {
       throw new Error("API_KEY_INVALID_GCP");
    }
    throw new Error(`Google Cloud TTS Fehler (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  if (data.audioContent) {
    return decodeBase64(data.audioContent);
  }
  throw new Error("Kein Audio-Inhalt in der Google Cloud Antwort");
}

// --- API Interactions ---

export async function generateSceneImage(text: string): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: getGeminiKey() });
  const prompt = `Erstelle eine filmreife, hochwertige digitale Illustration, die diese Szene darstellt. Stil: Atmosphärisch, detailliert. Szenenbeschreibung: ${text.slice(0, 500)}`;

  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: { parts: [{ text: prompt }] },
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
    throw new Error("Keine Bilddaten in der Antwort gefunden");
  });
}

// "THE BRAIN" - Uses Gemini 3 Flash for Analysis
async function analyzeTextForSegments(text: string): Promise<Array<{speaker: string, text: string}>> {
  const ai = new GoogleGenAI({ apiKey: getGeminiKey() });
  
  const schema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        speaker: { type: Type.STRING, description: "Name des Sprechers (z.B. 'Erzähler', 'Hans', 'Maria')" },
        text: { type: Type.STRING, description: "Der gesprochene Text" }
      },
      required: ["speaker", "text"]
    }
  };

  const promptContent = `Du bist ein professioneller Skript-Editor. 
      Analysiere den folgenden deutschen Text und teile ihn in Dialog-Segmente auf.
      
      Anweisungen:
      1. Identifiziere den 'Erzähler' (Narrator) und die verschiedenen Charaktere.
      2. 'Erzähler' übernimmt alle Beschreibungen, internen Gedanken und Redebegleitsätze.
      3. Charaktere übernehmen nur ihre wörtliche Rede.
      4. Fasse aufeinanderfolgende Segmente desselben Sprechers zusammen.
      5. Bewahre den Text EXAKT so wie er geschrieben steht. 
      6. Ignoriere leere Zeilen.
      
      Eingabetext:
      "${text.slice(0, 4500)}"`;

  return apiQueue.add(() => withRetry(async () => {
    try {
        // REQUESTED: Use Gemini 3 Flash Preview for the Auto-Cast Logic
        const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview", 
            contents: promptContent,
            config: {
                responseMimeType: "application/json",
                responseSchema: schema,
            }
        });

        const rawJSON = response.text || "[]";
        const parsed = JSON.parse(rawJSON);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        throw new Error("Empty segmentation");
    } catch (error: any) {
        const msg = (error.message || JSON.stringify(error)).toLowerCase();
        console.warn("Gemini 3 Flash segmentation failed, checking fallback...", msg);
        
        // Fallback to 2.5 Flash if 3 Flash is unavailable/permission denied
        if (msg.includes('permission') || msg.includes('403') || msg.includes('not found') || msg.includes('404')) {
            const fallbackResponse = await ai.models.generateContent({
                model: "gemini-2.5-flash-preview",
                contents: promptContent,
                config: {
                    responseMimeType: "application/json",
                    responseSchema: schema,
                }
            });
            const rawJSON = fallbackResponse.text || "[]";
            const parsed = JSON.parse(rawJSON);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
        
        throw error;
    }
  }).catch(e => {
      console.error("Auto-Cast Analyse fehlgeschlagen, spiele als Single-Speaker:", e);
      // Graceful fallback: Treat entire text as one Narrator block
      return [{ speaker: "Erzähler", text: text }]; 
  }));
}

async function generateSingleSpeakerAudio(text: string, voice: VoiceName, model: string): Promise<Uint8Array> {
  if (!text || !text.trim()) {
    throw new Error("Text ist leer");
  }

  // Wraps audio generation in the queue to respect concurrency limits
  return apiQueue.add(() => withRetry(async () => {
    const isGemini = model.startsWith('gemini');

    if (isGemini) {
      // Direct Gemini TTS (GenAI SDK)
      return await generateGeminiAudioRaw(text, voice, model);
    } else {
      // Google Cloud TTS (REST API)
      try {
        return await generateStandardGoogleTTSRaw(text, voice, model);
      } catch (err: any) {
        const msg = (err.message || "").toString();
        // Smart Fallback: If Cloud TTS fails (e.g. quota/auth), try Gemini TTS as backup
        if (msg === "API_KEY_INVALID_GCP" || msg.includes("403") || msg.includes("permission denied")) {
            console.warn(`GCP TTS fehlgeschlagen (${model}), fallback auf Gemini 2.5 Flash TTS.`);
            return await generateGeminiAudioRaw(text, voice, TTSModel.Gemini2_5_Flash_TTS);
        }
        throw err;
      }
    }
  }));
}

// --- Main Export ---

export async function generateSpeech(
  text: string, 
  voice: VoiceName, 
  model: string,
  isMultiSpeaker: boolean = false
): Promise<string> {
  // Cache key includes multi-speaker flag to differentiate between "Narration-only" and "Cast" versions
  const cacheKey = audioCache.generateKey(text, voice, model, isMultiSpeaker ? 'multi' : 'single');
  const cachedBase64 = await audioCache.get(cacheKey);
  if (cachedBase64) {
      console.log("Audio aus Cache geladen");
      return cachedBase64;
  }

  let resultBase64 = "";

  if (!isMultiSpeaker) {
    const audioBytes = await generateSingleSpeakerAudio(text, voice, model);
    resultBase64 = encodeBase64(audioBytes);
  } else {
    try {
      // 1. Analyze text using Gemini 3 Flash
      const segments = await analyzeTextForSegments(text);
      
      // Strict filtering of empty segments to prevent "skipping" glitches
      const validSegments = segments.filter(s => s.text && s.text.trim().length > 0);

      if (validSegments.length === 0) {
         const audioBytes = await generateSingleSpeakerAudio(text, voice, model);
         resultBase64 = encodeBase64(audioBytes);
      } else {
        // 2. Generate audio for each segment using the SELECTED model
        // This effectively "Auto-Casts" for any model (Gemini, Neural2, Studio, etc.)
        const audioPromises = validSegments.map(seg => {
            const assignedVoice = getVoiceForSpeaker(seg.speaker, voice);
            return generateSingleSpeakerAudio(seg.text, assignedVoice, model);
        });
        
        // 3. Concatenate results
        const audioBuffers = await Promise.all(audioPromises);
        const mergedAudio = concatAudioBuffers(audioBuffers);
        resultBase64 = encodeBase64(mergedAudio);
      }

    } catch (error: any) {
      if (error.message?.includes("Request cancelled")) {
        throw error;
      }
      
      const errorMsg = (error.message || JSON.stringify(error)).toLowerCase();
      // If Auto-Cast fails (e.g. quota on 3-Flash), fall back to reading the whole chunk as narrator
      console.error("Multi-Speaker Generierung fehlgeschlagen, fallback auf Single-Speaker:", error);
      const audioBytes = await generateSingleSpeakerAudio(text, voice, model);
      resultBase64 = encodeBase64(audioBytes);
    }
  }

  if (resultBase64) {
      await audioCache.set(cacheKey, resultBase64);
  }

  return resultBase64;
}