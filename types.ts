export enum VoiceName {
  Puck = 'Puck',
  Charon = 'Charon',
  Kore = 'Kore',
  Fenrir = 'Fenrir',
  Zephyr = 'Zephyr',
}

export enum TTSModel {
  Gemini2_5_Flash_TTS = 'gemini-2.5-flash-preview-tts',
  Gemini2_0_Flash_Exp = 'gemini-2.0-flash-exp',
  Google_Neural2 = 'google-neural2',
  Google_WaveNet = 'google-wavenet',
  Google_Chirp = 'google-chirp', // Studio voices
}

export const AVAILABLE_MODELS = [
  { value: TTSModel.Gemini2_5_Flash_TTS, label: 'Gemini 2.5 Flash TTS' },
  { value: TTSModel.Gemini2_0_Flash_Exp, label: 'Gemini 2.0 Flash (Exp)' },
  { value: TTSModel.Google_Neural2, label: 'Google Cloud Neural2 (DE)' },
  { value: TTSModel.Google_WaveNet, label: 'Google Cloud WaveNet (DE)' },
  { value: TTSModel.Google_Chirp, label: 'Google Cloud Studio (DE)' },
];

export interface AudioState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  isLoading: boolean;
  error: string | null;
  buffer: AudioBuffer | null;
}

export interface VoiceConfig {
  name: VoiceName;
  label: string;
  gender: 'Männlich' | 'Weiblich';
  description: string;
}

export const AVAILABLE_VOICES: VoiceConfig[] = [
  { name: VoiceName.Puck, label: 'Puck', gender: 'Männlich', description: 'Tief, resonant, erzählend' },
  { name: VoiceName.Charon, label: 'Charon', gender: 'Männlich', description: 'Autoritär, klar, nachrichtenartig' },
  { name: VoiceName.Kore, label: 'Kore', gender: 'Weiblich', description: 'Beruhigend, sanft, meditativ' },
  { name: VoiceName.Fenrir, label: 'Fenrir', gender: 'Männlich', description: 'Energetisch, schnell, gesprächig' },
  { name: VoiceName.Zephyr, label: 'Zephyr', gender: 'Weiblich', description: 'Freundlich, hell, hilfsbereit' },
];