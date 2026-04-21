import React from 'react';
import { formatTime } from '../utils/audioUtils';

interface PlayerBarProps {
  isPlaying: boolean;
  onPlayPause: () => void;
  onSeek: (percentage: number) => void;
  onGenerateImage: () => void;
  currentTime: number;
  duration: number;
  disabled?: boolean;
  title?: string;
  isGeneratingImage?: boolean;
  playbackRate?: number;
  onSetPlaybackRate?: (rate: number) => void;
}

export const PlayerBar: React.FC<PlayerBarProps> = ({
  isPlaying,
  onPlayPause,
  onSeek,
  onGenerateImage,
  currentTime,
  duration,
  disabled,
  title = "Bereit zur Synthese",
  isGeneratingImage = false,
  playbackRate = 1,
  onSetPlaybackRate
}) => {
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled || duration === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = x / rect.width;
    onSeek(percentage);
  };

  return (
    <div className="h-24 bg-stone-900 border-t border-stone-800 flex items-center px-4 md:px-12 gap-4 md:gap-6 relative z-50">
      {/* Play/Pause Button */}
      <button
        onClick={onPlayPause}
        disabled={disabled}
        className={`
          flex-shrink-0 w-10 h-10 md:w-12 md:h-12 rounded-full flex items-center justify-center transition-all
          ${disabled
            ? 'bg-stone-800 text-stone-600 cursor-not-allowed'
            : 'bg-indigo-500 text-white hover:bg-indigo-400 shadow-lg shadow-indigo-500/20'
          }
        `}
      >
        {isPlaying ? (
          <svg className="w-4 h-4 md:w-5 md:h-5 fill-current" viewBox="0 0 24 24">
            <rect x="6" y="4" width="4" height="16" />
            <rect x="14" y="4" width="4" height="16" />
          </svg>
        ) : (
          <svg className="w-4 h-4 md:w-5 md:h-5 fill-current ml-1" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      {/* Info & Progress */}
      <div className="flex-1 min-w-0 flex flex-col justify-center gap-2">
        <div className="flex justify-between items-end">
          <h3 className="text-sm font-medium text-stone-200 truncate pr-4">
             {title}
          </h3>
          <span className="text-xs font-mono text-stone-500">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        </div>

        {/* Clickable Progress Bar Container */}
        <div 
          className={`w-full h-2 bg-stone-800 rounded-full overflow-hidden relative group ${!disabled && 'cursor-pointer'}`}
          onClick={handleProgressClick}
        >
          {/* Active Progress */}
          <div
            className="h-full bg-indigo-500 rounded-full relative"
            style={{ width: `${progress}%` }}
          >
             {/* Handle knob (visual only, appears on hover) */}
             <div className="absolute right-0 top-1/2 transform translate-x-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full opacity-0 group-hover:opacity-100 shadow-sm transition-opacity" />
          </div>
        </div>
      </div>

      {/* Playback Speed Button */}
      {onSetPlaybackRate && (
        <div className="flex flex-col items-center justify-center gap-1 flex-shrink-0">
          <button
            onClick={() => {
              const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
              const currentIdx = speeds.indexOf(playbackRate);
              const nextIdx = (currentIdx + 1) % speeds.length;
              onSetPlaybackRate(speeds[nextIdx]);
            }}
            className="px-2 py-1 rounded-md bg-stone-800 border border-stone-700 text-stone-300 text-xs font-mono hover:border-indigo-500 transition-colors min-w-[3rem]"
            title="Playback-Geschwindigkeit"
          >
            {playbackRate}×
          </button>
        </div>
      )}

      {/* Scene Visualization Button */}
      <button
        onClick={onGenerateImage}
        disabled={disabled || isGeneratingImage}
        className={`
          flex flex-col items-center justify-center gap-1 px-3 py-2 rounded-lg border transition-all flex-shrink-0
          ${isGeneratingImage 
             ? 'bg-stone-800 border-stone-700 text-stone-500 cursor-wait' 
             : disabled 
                ? 'opacity-30 cursor-not-allowed border-stone-800'
                : 'bg-stone-900 border-stone-800 text-stone-400 hover:text-indigo-400 hover:border-indigo-500/50 hover:bg-stone-800'
          }
        `}
        title="Visualisiere die aktuelle Szene"
      >
        {isGeneratingImage ? (
           <svg className="animate-spin w-5 h-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
        ) : (
           <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
        )}
        <span className="hidden md:inline text-[10px] uppercase font-bold tracking-wider">Visualisieren</span>
      </button>
    </div>
  );
};