import React, { useState, useRef, useEffect } from 'react';
import { VoiceName, AudioState, TTSModel, AVAILABLE_MODELS } from './types';
import { decodeBase64, decodeAudioData } from './utils/audioUtils';
import { generateSpeech, generateSceneImage, cancelGenerations } from './services/geminiService';
import { parseFile } from './utils/fileParsers';
import { chunkText } from './utils/textProcessors';
import { VoiceSelector } from './components/VoiceSelector';
import { PlayerBar } from './components/PlayerBar';

// Reduced preload window to prevent aggressive queueing
const PRELOAD_WINDOW = 1;

const App: React.FC = () => {
  // --- Text & UI State ---
  const [text, setText] = useState<string>(
    "Willkommen beim ElevenReader Clone. Fügen Sie hier langen Text ein oder laden Sie ein ePub/PDF hoch, um die 'Bühnenlesung' in Aktion zu sehen. Sobald Sie beginnen, können Sie auf jeden Absatz tippen, um dorthin zu springen, oder auf 'Visualisieren' klicken, um die Szene zu sehen."
  );
  const [selectedVoice, setSelectedVoice] = useState<VoiceName>(VoiceName.Kore);
  const [selectedModel, setSelectedModel] = useState<TTSModel>(TTSModel.Gemini1_5_Flash);
  const [useMultiSpeaker, setUseMultiSpeaker] = useState<boolean>(false);
  const [isReaderMode, setIsReaderMode] = useState<boolean>(false);
  
  // --- Reading Session State ---
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showMobileVoices, setShowMobileVoices] = useState(false);
  
  // Text Chunks
  const [textChunks, setTextChunks] = useState<string[]>([]);
  const [currentChunkIndex, setCurrentChunkIndex] = useState<number>(0);
  
  // Audio Cache: Maps chunk index -> Promise<AudioBuffer>
  const audioCacheRef = useRef<Map<number, Promise<AudioBuffer>>>(new Map());

  const [audioState, setAudioState] = useState<AudioState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    isLoading: false,
    error: null,
    buffer: null,
  });

  // --- Refs for Robust State Management ---
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  
  // Visuals
  const startTimeRef = useRef<number>(0); 
  const progressFrameRef = useRef<number | null>(null);
  const activeChunkRef = useRef<HTMLDivElement | null>(null);
  
  // IO
  const fileInputRef = useRef<HTMLInputElement>(null);

  // CRITICAL: Concurrency Control
  // Increments on every play/stop action. Async ops check this ID before proceeding.
  const playbackIdRef = useRef<number>(0); 
  // Keeps track of the active index independently of React State to avoid closure staleness
  const activeIndexRef = useRef<number>(0);

  // --- Cleanup ---
  useEffect(() => {
    return () => stopPlaybackFull();
  }, []);

  // Scroll to active chunk
  useEffect(() => {
    if (isReaderMode && activeChunkRef.current) {
        activeChunkRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentChunkIndex, isReaderMode]);

  // --- Audio Context Management ---
  const getAudioContext = async () => {
    if (!audioContextRef.current) {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioContextClass();
      gainNodeRef.current = audioContextRef.current.createGain();
      gainNodeRef.current.connect(audioContextRef.current.destination);
    }
    return audioContextRef.current;
  };

  const stopPlaybackFull = () => {
    // 1. Invalidate all pending async operations
    playbackIdRef.current++; 

    // 2. Cancel API calls
    cancelGenerations();

    // 3. Stop Audio
    if (sourceNodeRef.current) {
      try { 
        sourceNodeRef.current.onended = null; // Prevent callback
        sourceNodeRef.current.stop(); 
        sourceNodeRef.current.disconnect(); 
      } catch {}
      sourceNodeRef.current = null;
    }
    if (progressFrameRef.current) cancelAnimationFrame(progressFrameRef.current);
    
    // 4. Reset State
    if (!isReaderMode) {
        audioCacheRef.current.clear();
    }
    
    setAudioState(prev => ({ 
      ...prev, 
      isPlaying: false, 
      isLoading: false,
      currentTime: 0, 
      duration: 0,
      buffer: null
    }));
  };

  // --- Fetching Logic ---

  const fetchAudioForChunk = (index: number, chunkText: string): Promise<AudioBuffer> => {
    // If cached, return immediately
    if (audioCacheRef.current.has(index)) {
      return audioCacheRef.current.get(index)!;
    }

    const promise = (async () => {
        const ctx = await getAudioContext();
        // Generate (will check IndexedDB cache internally first)
        const base64 = await generateSpeech(chunkText, selectedVoice, selectedModel, useMultiSpeaker);
        const bytes = decodeBase64(base64);
        return await decodeAudioData(bytes, ctx);
    })();

    // CRITICAL FIX: If the promise fails (e.g. cancelled request), REMOVE it from cache.
    // Otherwise, subsequent retries will hit the failed promise and error out immediately (skipping).
    promise.catch(err => {
        if (audioCacheRef.current.get(index) === promise) {
            audioCacheRef.current.delete(index);
        }
    });

    audioCacheRef.current.set(index, promise);
    return promise;
  };

  const ensurePreload = (currentIndex: number, allChunks: string[]) => {
    for (let i = 1; i <= PRELOAD_WINDOW; i++) {
        const nextIndex = currentIndex + i;
        if (nextIndex < allChunks.length) {
            fetchAudioForChunk(nextIndex, allChunks[nextIndex]);
        }
    }
  };

  // --- Playback Logic ---

  const playChunk = async (index: number, allChunks: string[], startOffset: number = 0) => {
    // 1. BOUNDARY CHECK
    if (index >= allChunks.length) {
        setAudioState(prev => ({ ...prev, isPlaying: false, currentTime: 0 }));
        return;
    }

    // 2. GENERATE NEW PLAYBACK ID
    // This invalidates any other `playChunk` calls currently waiting on await
    const currentPlayId = ++playbackIdRef.current;
    
    // 3. UPDATE SYNC REFS
    activeIndexRef.current = index;
    
    try {
        const ctx = await getAudioContext();
        
        // 4. UI UPDATE (Optimistic)
        setCurrentChunkIndex(index);
        setAudioState(prev => ({ ...prev, isLoading: true, error: null }));

        // 5. STOP PREVIOUS SOURCE IMMEDIATELY
        if (sourceNodeRef.current) {
             try { 
                 sourceNodeRef.current.onended = null; // Important: detach old handler
                 sourceNodeRef.current.stop(); 
                 sourceNodeRef.current.disconnect(); 
             } catch {}
             sourceNodeRef.current = null;
        }

        // 6. FETCH AUDIO
        // If the user clicks another chunk while this awaits, `playbackIdRef` will increment.
        const buffer = await fetchAudioForChunk(index, allChunks[index]);

        // 7. RACE CONDITION CHECK
        if (playbackIdRef.current !== currentPlayId) {
            console.log("Playback cancelled: ID mismatch (user navigated away)");
            return;
        }

        // 8. CREATE SOURCE
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(gainNodeRef.current!);
        
        // 9. SETUP NEXT CHUNK HANDLER
        source.onended = () => {
             // Only proceed if this is still the active playback session
             if (playbackIdRef.current === currentPlayId) {
                 // Break call stack to ensure clean state transition
                 setTimeout(() => {
                    if (playbackIdRef.current === currentPlayId) {
                        playChunk(index + 1, allChunks);
                    }
                 }, 10);
             }
        };

        // 10. START PLAYBACK
        const safeOffset = Math.min(startOffset, buffer.duration);

        // Ensure context is running before starting
        if (ctx.state === 'suspended') {
            await ctx.resume();
        }

        source.start(0, safeOffset);
        sourceNodeRef.current = source;
        
        // 11. FINAL UI UPDATE
        startTimeRef.current = ctx.currentTime - safeOffset;
        setAudioState({
            isPlaying: true,
            currentTime: safeOffset,
            duration: buffer.duration,
            isLoading: false,
            error: null,
            buffer: buffer
        });

        startVisualTimer(buffer.duration);
        ensurePreload(index, allChunks);

        // 12. Garbage Collection
        if (index > 2) audioCacheRef.current.delete(index - 3);

    } catch (err: any) {
        // Only handle error if we are still the active session
        if (playbackIdRef.current === currentPlayId) {
            let msg = typeof err === 'string' ? err : (err.message || JSON.stringify(err));
            
            if (msg.includes('429') || msg.toLowerCase().includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
                msg = "API Limit erreicht. Bitte warten Sie einen Moment.";
            } else if (msg.includes('cancelled')) {
                 return;
            } else if (msg.includes('fetch')) {
                 msg = "Verbindungsfehler. Bitte überprüfen Sie Ihr Internet.";
            }

            setAudioState(prev => ({ 
                ...prev, 
                isLoading: false, 
                isPlaying: false,
                error: msg 
            }));
        }
    }
  };

  // Only updates the visual progress bar, does NOT control logic
  const startVisualTimer = (duration: number) => {
    if (progressFrameRef.current) cancelAnimationFrame(progressFrameRef.current);
    
    const loop = () => {
      // Check ID to stop timer if we switched context
      if (!audioContextRef.current) return;
      
      const now = audioContextRef.current.currentTime;
      const elapsed = now - startTimeRef.current;

      if (elapsed < duration) {
        setAudioState(prev => ({ ...prev, currentTime: elapsed }));
        progressFrameRef.current = requestAnimationFrame(loop);
      } else {
        setAudioState(prev => ({ ...prev, currentTime: duration }));
      }
    };
    progressFrameRef.current = requestAnimationFrame(loop);
  };

  // --- Interaction Handlers ---

  const startReading = async () => {
      if (!text.trim()) return;

      stopPlaybackFull();
      audioCacheRef.current.clear();
      setIsReaderMode(true);
      setGeneratedImageUrl(null);

      // Longer chunks reduce api calls overhead and improve continuity
      const chunks = chunkText(text, 1500); 
      setTextChunks(chunks);
      setCurrentChunkIndex(0);

      await getAudioContext();
      
      // Delay slightly to ensure UI is ready
      setTimeout(() => {
          playChunk(0, chunks);
      }, 100);
  };

  const jumpToChunk = async (index: number) => {
      // CLEAR QUEUE: Clear pending API calls so the jump isn't blocked by old preloads
      cancelGenerations();

      if (audioContextRef.current?.state === 'suspended') await audioContextRef.current.resume();
      playChunk(index, textChunks);
  };

  const togglePlayPause = async () => {
      const ctx = await getAudioContext();
      
      if (audioState.isPlaying) {
          ctx.suspend();
          setAudioState(prev => ({ ...prev, isPlaying: false }));
      } else {
          ctx.resume();
          setAudioState(prev => ({ ...prev, isPlaying: true }));
      }
  };

  const handleSeek = (percentage: number) => {
    if (!audioState.buffer) return;
    const newTime = percentage * audioState.buffer.duration;
    // Seek implies restarting the current chunk at offset
    playChunk(currentChunkIndex, textChunks, newTime);
  };

  const handleGenerateImage = async () => {
      if (!textChunks[currentChunkIndex]) return;
      setIsGeneratingImage(true);
      try {
          const imgUrl = await generateSceneImage(textChunks[currentChunkIndex]);
          setGeneratedImageUrl(imgUrl);
      } catch (e: any) {
          setAudioState(prev => ({ ...prev, error: "Bildgenerierung fehlgeschlagen." }));
      } finally {
          setIsGeneratingImage(false);
      }
  };

  const processFile = async (file: File) => {
    stopPlaybackFull(); // Reset when loading new file
    setIsProcessingFile(true);
    setAudioState(prev => ({ ...prev, error: null }));
    try {
      const extractedText = await parseFile(file);
      setText(extractedText);
      setIsReaderMode(false);
    } catch (err: any) {
      setAudioState(prev => ({ ...prev, error: `Import fehlgeschlagen: ${err.message}` }));
    } finally {
      setIsProcessingFile(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-stone-950 text-stone-200">
      <input type="file" ref={fileInputRef} onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) processFile(file);
        e.target.value = '';
      }} accept=".pdf,.epub,.txt,.md" className="hidden" />

      <header className="flex-shrink-0 h-16 border-b border-stone-800 flex items-center px-6 justify-between bg-stone-950 z-20">
        <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-indigo-500 rounded-lg flex items-center justify-center text-white font-bold text-lg">11</div>
          <h1 className="text-lg font-bold text-white">ElevenReader <span className="text-stone-500 font-normal">Klon</span></h1>
        </div>
        <div className="flex items-center gap-2">
            {isReaderMode && (
                <button 
                  onClick={() => {
                      stopPlaybackFull();
                      setIsReaderMode(false);
                  }}
                  className="text-xs font-mono text-stone-500 hover:text-stone-300 transition-colors uppercase"
                >
                    Text Bearbeiten
                </button>
            )}
            <div className="text-xs font-mono text-stone-600 border border-stone-800 rounded px-2 py-1 uppercase tracking-tighter">
                Interaktiv
            </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <aside className="w-80 border-r border-stone-800 bg-stone-925 overflow-y-auto hidden md:flex flex-col p-6 gap-8 shrink-0">
           {/* Image Display */}
           {generatedImageUrl && (
               <div className="animate-in fade-in slide-in-from-left-4">
                    <h2 className="text-xs font-bold text-stone-500 uppercase tracking-wider mb-2">Szenenbild</h2>
                    <div className="rounded-lg overflow-hidden border border-stone-700 shadow-xl bg-black aspect-square relative group">
                        <img src={generatedImageUrl} alt="Scene" className="w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2">
                            <span className="text-xs text-white/80">Gemini 1.5 Flash Image</span>
                        </div>
                    </div>
               </div>
           )}

           <div>
              <h2 className="text-xs font-bold text-stone-500 uppercase tracking-wider mb-4">Bibliothek</h2>
              <button 
                onClick={() => fileInputRef.current?.click()}
                disabled={isProcessingFile}
                className="w-full flex items-center gap-3 p-3 rounded-lg bg-stone-900 border border-stone-800 hover:bg-stone-800 transition-all group"
              >
                 <div className="w-8 h-8 rounded-full bg-stone-800 flex items-center justify-center group-hover:bg-indigo-500/20 group-hover:text-indigo-400 transition-colors">
                    <svg className="w-4 h-4 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                 </div>
                 <div className="text-left">
                     <div className="text-sm font-medium text-stone-200">Buch importieren</div>
                     <div className="text-xs text-stone-500">PDF, ePub, TXT</div>
                 </div>
              </button>
           </div>

           <div>
              {/* Model Selector */}
              <div className="mb-6">
                <h2 className="text-xs font-bold text-stone-500 uppercase tracking-wider mb-2">Modell</h2>
                <div className="space-y-2">
                    {AVAILABLE_MODELS.map(model => (
                        <button
                            key={model.value}
                            onClick={() => setSelectedModel(model.value)}
                            disabled={audioState.isLoading || isProcessingFile || audioState.isPlaying}
                            className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                                selectedModel === model.value 
                                ? 'bg-stone-800 border-indigo-500 text-stone-200 shadow-sm shadow-indigo-500/10' 
                                : 'bg-stone-900 border-stone-800 text-stone-400 hover:bg-stone-800 hover:text-stone-300'
                            }`}
                        >
                            {model.label}
                        </button>
                    ))}
                </div>
              </div>

              <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xs font-bold text-stone-500 uppercase tracking-wider">Stimmen</h2>
                  <div className="flex items-center gap-2">
                      <span className="text-[10px] text-stone-500 font-bold uppercase">Auto-Cast</span>
                      <button 
                        onClick={() => setUseMultiSpeaker(!useMultiSpeaker)}
                        className={`w-8 h-4 rounded-full transition-colors relative ${useMultiSpeaker ? 'bg-indigo-500' : 'bg-stone-800'}`}
                      >
                        <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${useMultiSpeaker ? 'left-[1.125rem]' : 'left-0.5'}`} />
                      </button>
                  </div>
              </div>
              
              <VoiceSelector 
                label="Erzähler"
                selectedVoice={selectedVoice} 
                onSelectVoice={setSelectedVoice} 
                disabled={audioState.isLoading || isProcessingFile || audioState.isPlaying} 
              />

              {useMultiSpeaker && (
                  <div className="mt-4 p-3 bg-stone-900 border border-stone-800 rounded-lg animate-in fade-in slide-in-from-top-2 border-l-4 border-l-indigo-500">
                     <p className="text-[11px] text-stone-500 leading-relaxed italic">
                        Charaktere werden automatisch erkannt. Der Erzähler verwendet die gewählte Stimme.
                     </p>
                  </div>
              )}
           </div>
        </aside>

        {/* Main Content */}
        <main 
            className="flex-1 flex flex-col relative min-w-0 bg-stone-950"
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={async (e) => { 
                e.preventDefault(); setIsDragging(false); 
                const file = e.dataTransfer.files?.[0];
                if (file) await processFile(file);
            }}
        >
          {isDragging && (
             <div className="absolute inset-0 z-50 bg-indigo-500/10 backdrop-blur-sm border-2 border-dashed border-indigo-500 flex flex-col items-center justify-center">
                <div className="text-2xl font-bold text-indigo-200 animate-bounce">Datei hier ablegen</div>
             </div>
          )}

          {/* Mobile Upload & Voice Controls */}
          <div className="md:hidden border-b border-stone-800 bg-stone-900/30 flex flex-col">
              <div className="p-4 flex gap-2">
                <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-1 py-2 bg-stone-800 rounded text-xs font-medium border border-stone-700 text-stone-300 hover:bg-stone-700 transition-colors"
                >
                    Upload
                </button>
                <button
                    onClick={() => setShowMobileVoices(!showMobileVoices)}
                    className={`flex-1 py-2 rounded text-xs font-medium border transition-colors ${showMobileVoices ? 'bg-stone-800 text-stone-200 border-stone-600' : 'bg-stone-800 border-stone-700 text-stone-400'}`}
                >
                    Einstellungen
                </button>
                <button
                    onClick={() => setUseMultiSpeaker(!useMultiSpeaker)}
                    className={`flex-1 px-3 py-2 rounded text-xs font-medium border ${useMultiSpeaker ? 'bg-indigo-500/20 border-indigo-500 text-indigo-200' : 'bg-stone-800 border-stone-700 text-stone-400'}`}
                >
                    Auto-Cast: {useMultiSpeaker ? "AN" : "AUS"}
                </button>
              </div>

              {/* Mobile Voice & Model Panel */}
              {showMobileVoices && (
                  <div className="p-4 border-t border-stone-800 bg-stone-950 animate-in fade-in slide-in-from-top-2">
                     <div className="mb-4 pb-4 border-b border-stone-800">
                        <label className="text-xs font-semibold uppercase tracking-wider text-stone-500 mb-2 block">Modell</label>
                        <div className="grid grid-cols-2 gap-2">
                            {AVAILABLE_MODELS.map(model => (
                                <button
                                    key={model.value}
                                    onClick={() => setSelectedModel(model.value)}
                                    className={`px-3 py-2 rounded text-xs font-medium border transition-colors ${
                                        selectedModel === model.value 
                                        ? 'bg-stone-800 border-indigo-500 text-stone-200' 
                                        : 'bg-stone-900 border-stone-800 text-stone-400'
                                    }`}
                                >
                                    {model.label}
                                </button>
                            ))}
                        </div>
                     </div>

                     <VoiceSelector 
                        label="Erzähler wählen"
                        selectedVoice={selectedVoice} 
                        onSelectVoice={(v) => {
                            setSelectedVoice(v);
                        }} 
                        disabled={audioState.isLoading || isProcessingFile || audioState.isPlaying} 
                     />
                     {useMultiSpeaker && (
                        <div className="mt-3 text-[10px] text-stone-500 italic">
                            * Multi-Speaker Modus aktiv. Diese Stimme ist nur für den Erzähler.
                        </div>
                     )}
                  </div>
              )}
          </div>

          <div className="flex-1 overflow-y-auto p-6 md:p-12 lg:px-24">
             {/* Mobile Image Display (Only visible on mobile if image exists) */}
             {generatedImageUrl && (
                 <div className="md:hidden mb-6 animate-in fade-in slide-in-from-top-4">
                    <div className="rounded-lg overflow-hidden border border-stone-700 shadow-xl bg-black aspect-square relative">
                        <img src={generatedImageUrl} alt="Scene" className="w-full h-full object-cover" />
                        <button 
                           onClick={() => setGeneratedImageUrl(null)}
                           className="absolute top-2 right-2 p-1 bg-black/50 text-white rounded-full backdrop-blur-md"
                        >
                           <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"/></svg>
                        </button>
                        <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent p-2">
                            <span className="text-xs text-white/80">Gemini 1.5 Flash Image</span>
                        </div>
                    </div>
                 </div>
             )}

             {!isReaderMode ? (
                 <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Text einfügen oder Buch hochladen..."
                    className="w-full h-full bg-transparent border-none resize-none focus:ring-0 text-lg md:text-xl lg:text-2xl font-serif leading-relaxed text-stone-300 placeholder-stone-700 outline-none"
                    spellCheck={false}
                 />
             ) : (
                 <div className="space-y-6 pb-24">
                    {textChunks.map((chunk, idx) => (
                        <div 
                            key={idx}
                            ref={idx === currentChunkIndex ? activeChunkRef : null}
                            onClick={() => jumpToChunk(idx)}
                            className={`
                                font-serif text-lg md:text-xl lg:text-2xl leading-relaxed transition-all duration-300 cursor-pointer p-4 rounded-xl border
                                ${idx === currentChunkIndex 
                                    ? 'bg-stone-900/80 text-white border-stone-800 shadow-2xl scale-[1.02] ring-1 ring-indigo-500/30' 
                                    : 'text-stone-500 hover:text-stone-300 hover:bg-stone-900/30 border-transparent'
                                }
                            `}
                        >
                            {chunk}
                        </div>
                    ))}
                 </div>
             )}
          </div>
          
          <div className="absolute bottom-6 right-6 md:bottom-12 md:right-12 z-10 flex flex-col items-end gap-3 pointer-events-none">
             {/* Main Action Button (Only visible if not reading, or processing) */}
             <div className="pointer-events-auto">
                {isProcessingFile && (
                    <div className="mb-2 px-4 py-2 bg-stone-900 border border-stone-800 rounded-full text-xs text-stone-400 animate-pulse">
                    Text wird extrahiert...
                    </div>
                )}
                
                {!isReaderMode && !audioState.isLoading && (
                <button
                    onClick={startReading}
                    disabled={isProcessingFile || !text.trim()}
                    className="flex items-center gap-2 px-8 py-4 rounded-full font-bold shadow-2xl bg-white text-black hover:bg-stone-200 transition-all transform hover:scale-105"
                >
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                    <span>Vorlesen starten</span>
                </button>
                )}

                {audioState.isLoading && (
                    <div className="px-6 py-3 rounded-full bg-stone-800 text-stone-400 flex items-center gap-3 border border-stone-700 shadow-xl">
                        <svg className="animate-spin h-5 w-5 text-indigo-500" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                        <span>{useMultiSpeaker ? "Casting läuft..." : "Lädt..."}</span>
                    </div>
                )}
             </div>
          </div>
          
          {audioState.error && (
            <div className="absolute top-6 left-1/2 transform -translate-x-1/2 bg-red-500/10 border border-red-500/50 text-red-200 px-6 py-3 rounded-xl backdrop-blur-md text-sm z-50 animate-in fade-in slide-in-from-top-4 shadow-2xl max-w-sm text-center">
                {audioState.error}
            </div>
          )}
        </main>
      </div>

      <PlayerBar 
        isPlaying={audioState.isPlaying} 
        onPlayPause={togglePlayPause} 
        onSeek={handleSeek}
        onGenerateImage={handleGenerateImage}
        isGeneratingImage={isGeneratingImage}
        currentTime={audioState.currentTime} 
        duration={audioState.duration} 
        disabled={!audioState.buffer} 
        title={audioState.buffer ? (useMultiSpeaker ? "Multi-Cast Audio" : "Erzähltes Audio") : "ElevenReader"} 
      />
    </div>
  );
};

export default App;