import React from 'react';
import { VoiceName, AVAILABLE_VOICES, VoiceConfig } from '../types';

interface VoiceSelectorProps {
  label?: string;
  selectedVoice: VoiceName;
  onSelectVoice: (voice: VoiceName) => void;
  disabled?: boolean;
}

export const VoiceSelector: React.FC<VoiceSelectorProps> = ({ 
  label = "Erzähler-Stimme",
  selectedVoice, 
  onSelectVoice, 
  disabled 
}) => {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-semibold uppercase tracking-wider text-stone-500">
        {label}
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-2">
        {AVAILABLE_VOICES.map((voice: VoiceConfig) => (
          <button
            key={voice.name}
            onClick={() => onSelectVoice(voice.name)}
            disabled={disabled}
            className={`
              flex items-center gap-3 p-3 rounded-lg border text-left transition-all
              ${selectedVoice === voice.name
                ? 'bg-stone-800 border-indigo-500 shadow-md shadow-indigo-500/10'
                : 'bg-stone-900 border-stone-800 hover:bg-stone-800 hover:border-stone-700'
              }
              ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
            `}
          >
            <div className={`
              w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold
              ${selectedVoice === voice.name ? 'bg-indigo-500 text-white' : 'bg-stone-800 text-stone-400'}
            `}>
              {voice.label.charAt(0)}
            </div>
            <div>
              <div className="text-sm font-medium text-stone-200">{voice.label}</div>
              <div className="text-xs text-stone-500">{voice.gender} • {voice.description}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};