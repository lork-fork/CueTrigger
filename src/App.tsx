import { SquareActivity, Plus, Play, Settings2, Volume2, Save, FolderOpen, RotateCcw, ListMusic } from 'lucide-react';
import NodeEditor from './components/NodeEditor';
import PerformanceMode from './components/PerformanceMode';
import TransportControls from './components/TransportControls';
import PlaylistDrawer from './components/PlaylistDrawer';
import { useAppStore } from './store';
import { audioEngine } from './audioEngine';
import React, { useEffect, useRef, useState } from 'react';
import { saveSession, loadSession } from './sessionManager';
import { loadSessionFromStorage, saveSessionToStorage, clearStorage, requestPersistentStorage } from './storage';
import { AudioNodeData, NamedPlaylist, getAllTracks } from './types';
import { AppNode } from './store';
import './sequenceRunner';
import { playlistEngine } from './playlistEngine';
import { AlertTriangle } from 'lucide-react';

// Decode every cue and playlist file up front so no GO waits on decoding
function preloadSessionAudio(nodes: AppNode[], playlists: NamedPlaylist[] = []) {
  audioEngine.preloadAudio([
    ...nodes
      .filter((node) => node.type === 'audioNode')
      .map((node) => ({ url: (node.data as AudioNodeData).audioUrl, id: node.id })),
    ...getAllTracks(playlists).map((track) => ({ url: track.audioUrl, id: `track-${track.id}` })),
  ]);
}

// Shows a banner whenever the audio output isn't running (not started yet, device unplugged,
// OS took the audio device). Clicking it tries to restart audio.
function AudioOfflineBanner() {
  const [state, setState] = useState(audioEngine.getContextState());
  useEffect(() => {
    const update = () => setState(audioEngine.getContextState());
    const unsubscribe = audioEngine.subscribe(update);
    const interval = setInterval(update, 1000);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, []);
  if (state === 'running') return null;
  return (
    <button
      onClick={() => {
        audioEngine.init();
        audioEngine.context?.resume().catch(() => {});
      }}
      className="w-full bg-amber-500 text-slate-950 text-sm font-bold px-4 py-2 flex items-center justify-center gap-2 z-50 cursor-pointer hover:bg-amber-400"
    >
      <AlertTriangle size={16} />
      {state === 'closed' ? 'AUDIO OFFLINE. Reload the page to restore sound.' : 'AUDIO NOT RUNNING. Click here to start sound.'}
    </button>
  );
}

function AudioMeter() {
  const [level, setLevel] = useState(0);
  const requestRef = useRef<number>();

  useEffect(() => {
    const updateMeter = () => {
      setLevel(audioEngine.getMeterLevel());
      requestRef.current = requestAnimationFrame(updateMeter);
    };
    requestRef.current = requestAnimationFrame(updateMeter);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, []);

  // Map level to percentage, cap at 100%
  const widthPercent = Math.min(100, Math.max(0, level * 100));
  
  return (
    <div className="flex flex-col justify-center items-center gap-1 w-24 h-full px-2" title="Master Audio Level">
      <div className="w-full h-1.5 bg-slate-800 rounded overflow-hidden flex">
        <div 
          className="h-full transition-all duration-75 ease-out bg-green-500" 
          style={{ width: `${Math.min(70, widthPercent)}%` }} 
        />
        {widthPercent > 70 && (
           <div 
             className="h-full transition-all duration-75 ease-out bg-yellow-500" 
             style={{ width: `${Math.min(20, widthPercent - 70)}%` }} 
           />
        )}
        {widthPercent > 90 && (
           <div 
             className="h-full transition-all duration-75 ease-out bg-red-500" 
             style={{ width: `${widthPercent - 90}%` }} 
           />
        )}
      </div>
    </div>
  );
}

export default function App() {
  const {
    mode,
    setMode,
    globalVolume,
    setGlobalVolume,
    addNode,
    nodes,
    edges,
    loadState,
    playlists,
    viewedPlaylistId,
    playlistSettings,
    isPlaylistDrawerOpen,
    setIsPlaylistDrawerOpen,
    notice,
    setNotice,
  } = useAppStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const errorMessage = notice;
  const setErrorMessage = setNotice;

  // Restore saved session from IndexedDB on launch
  useEffect(() => {
    let active = true;
    async function restore() {
      requestPersistentStorage();
      try {
        const stored = await loadSessionFromStorage();
        if (active && stored) {
          loadState(stored.nodes, stored.edges, stored.globalVolume, stored.playlists, stored.playlistSettings, stored.viewedPlaylistId);
          if (stored.mode) {
            setMode(stored.mode);
          }
          preloadSessionAudio(stored.nodes, stored.playlists);
        }
      } catch (err) {
        console.error('Failed to restore session from IndexedDB:', err);
      } finally {
        if (active) {
          setIsHydrated(true);
        }
      }
    }
    restore();
    return () => {
      active = false;
    };
  }, [loadState, setMode]);

  // Debounced auto-save to IndexedDB whenever session changes
  useEffect(() => {
    if (!isHydrated) return;

    const timer = setTimeout(() => {
      saveSessionToStorage({
        nodes,
        edges,
        globalVolume,
        mode,
        playlists,
        viewedPlaylistId,
        playlistSettings,
      });
    }, 300);

    return () => clearTimeout(timer);
  }, [nodes, edges, globalVolume, mode, playlists, viewedPlaylistId, playlistSettings, isHydrated]);

  // Save synchronously before page unload or refresh
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Ask before reloading or closing while sound is playing
      if (audioEngine.getPlayingTriggerIds().length > 0 || playlistEngine.isPlaying) {
        e.preventDefault();
        e.returnValue = '';
      }
      if (isHydrated) {
        saveSessionToStorage({
          nodes,
          edges,
          globalVolume,
          mode,
          playlists,
          viewedPlaylistId,
          playlistSettings,
        });
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [nodes, edges, globalVolume, mode, playlists, viewedPlaylistId, playlistSettings, isHydrated]);

  const handleSave = async () => {
    await saveSession(nodes, edges, globalVolume, playlists, playlistSettings);
  };

  const handleLoad = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const {
          nodes: loadedNodes,
          edges: loadedEdges,
          globalVolume: loadedVolume,
          playlists: loadedPlaylists,
          playlistSettings: loadedSettings,
        } = await loadSession(file);
        // Start from a clean slate: stop everything and drop audio decoded for the previous show
        audioEngine.stopAll(0);
        playlistEngine.stop();
        audioEngine.clearAudioCache();
        loadState(loadedNodes, loadedEdges, loadedVolume, loadedPlaylists, loadedSettings);
        playlistEngine.playingPlaylistId = null;
        preloadSessionAudio(loadedNodes, loadedPlaylists);
        setErrorMessage(null);
      } catch (error) {
        console.error('Failed to load session:', error);
        setErrorMessage('Failed to load session file. Please make sure it is a valid CueTrigger show .zip.');
        setTimeout(() => setErrorMessage(null), 5000);
      }
    }
    if (e.target) e.target.value = '';
  };

  const handleClearSession = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    audioEngine.stopAll(0);
    playlistEngine.stop();
    audioEngine.clearAudioCache();
    await clearStorage();
    loadState([], [], 1, [], { crossfadeDuration: 2.0, shuffle: false, loop: false, volume: 1.0 });
    playlistEngine.playingPlaylistId = null;
    setConfirmClear(false);
  };

  // A file dropped anywhere the app doesn't handle it must not navigate away from the show
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  useEffect(() => {
    audioEngine.setGlobalVolume(globalVolume);
  }, [globalVolume]);

  useEffect(() => {
    audioEngine.setPlaylistVolume(playlistSettings.volume ?? 1);
  }, [playlistSettings.volume]);

  return (
    <div className="h-screen w-full flex flex-col bg-slate-950 text-slate-200 overflow-hidden font-sans">
      <AudioOfflineBanner />
      {errorMessage && (
        <div className="bg-red-500/90 text-white text-xs px-4 py-1.5 flex justify-between items-center z-50">
          <span>{errorMessage}</span>
          <button onClick={() => setErrorMessage(null)} className="underline ml-2">Dismiss</button>
        </div>
      )}
      {/* Top Bar */}
      <div className="h-14 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 mr-4 text-green-400 font-bold">
            <SquareActivity size={24} />
            <span className="hidden sm:inline">CueTrigger</span>
          </div>
          
          <div className="flex bg-slate-950 rounded-lg p-1 border border-slate-800">
            <button
              onClick={() => setMode('editor')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-2 transition-colors ${
                mode === 'editor' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Settings2 size={16} /> Editor
            </button>
            <button
              onClick={() => setMode('performance')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-2 transition-colors ${
                mode === 'performance' ? 'bg-slate-800 text-green-400 shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Play size={16} /> Performance
            </button>
          </div>

          <div className="flex items-center gap-2 border-l border-slate-800 pl-4 ml-2">
            <button onClick={handleSave} className="text-slate-400 hover:text-white p-1.5 rounded-md hover:bg-slate-800 transition-colors" title="Save Session (.zip)">
              <Save size={18} />
            </button>
            <button onClick={() => fileInputRef.current?.click()} className="text-slate-400 hover:text-white p-1.5 rounded-md hover:bg-slate-800 transition-colors" title="Load Session (.zip)">
              <FolderOpen size={18} />
            </button>
            <button 
              onClick={handleClearSession} 
              className={`p-1.5 rounded-md transition-colors flex items-center gap-1 text-xs font-semibold ${
                confirmClear 
                  ? 'bg-red-600 text-white hover:bg-red-500 px-2' 
                  : 'text-slate-400 hover:text-red-400 hover:bg-slate-800'
              }`} 
              title={confirmClear ? "Click again to confirm clearing session" : "New / Clear Session"}
            >
              <RotateCcw size={16} />
              {confirmClear && <span>Confirm Clear?</span>}
            </button>
            <input type="file" accept=".zip" ref={fileInputRef} onChange={handleLoad} className="hidden" />
          </div>
        </div>

        <div className="flex items-center gap-6">
          {/* Playlist Toggle */}
          <button
            onClick={() => setIsPlaylistDrawerOpen(!isPlaylistDrawerOpen)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium flex items-center gap-2 transition-all cursor-pointer ${
              isPlaylistDrawerOpen
                ? 'bg-blue-600 text-white shadow-md'
                : 'bg-slate-800 text-slate-300 hover:text-white hover:bg-slate-700 border border-slate-700'
            }`}
            title="Toggle Playlist Drawer"
          >
            <ListMusic size={16} />
            <span className="hidden md:inline">Playlist</span>
            {(playlists.find(p => p.id === viewedPlaylistId)?.tracks.length ?? 0) > 0 && (
              <span className="text-[11px] font-mono font-bold px-1.5 py-0.2 rounded-full bg-slate-900 text-blue-400 border border-slate-700">
                {playlists.find(p => p.id === viewedPlaylistId)?.tracks.length ?? 0}
              </span>
            )}
          </button>

          {/* Global Volume and Meter */}
          <div className="flex items-center gap-4 hidden md:flex">
             <div className="flex items-center gap-2 w-32">
                <Volume2 size={16} className="text-slate-400" />
                <input
                   type="range"
                   min="0"
                   max="2"
                   step="0.01"
                   value={globalVolume}
                   onChange={(e) => setGlobalVolume(parseFloat(e.target.value))}
                   className="w-full accent-green-500"
                />
             </div>
             <AudioMeter />
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 relative flex flex-col">
         {mode === 'editor' && (
           <>
             {/* Toolbar for Editor */}
             <div className="absolute top-4 left-4 z-10 flex gap-2">
               <button 
                 onClick={() => addNode('triggerNode')}
                 className="bg-green-600 hover:bg-green-500 text-white px-3 py-2 rounded-md text-sm font-medium flex items-center gap-2 shadow-lg transition-colors border border-green-400/30"
               >
                 <Plus size={16} /> Trigger
               </button>
               <button 
                 onClick={() => addNode('audioNode')}
                 className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-2 rounded-md text-sm font-medium flex items-center gap-2 shadow-lg transition-colors border border-blue-400/30"
               >
                 <Plus size={16} /> Audio
               </button>
               <button 
                 onClick={() => addNode('crossFadeNode')}
                 className="bg-purple-600 hover:bg-purple-500 text-white px-3 py-2 rounded-md text-sm font-medium flex items-center gap-2 shadow-lg transition-colors border border-purple-400/30"
               >
                 <Plus size={16} /> Crossfade
               </button>
             </div>

             {/* Center Transport Controls (Instant Pause / Fade Pause / Resume / Reset All) */}
             <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
               <TransportControls />
             </div>

             <NodeEditor />
           </>
         )}

         {mode === 'performance' && (
           <PerformanceMode />
         )}
      </div>

      {/* Playlist Drawer (Right Side & Collapsed Mini-Player) */}
      <PlaylistDrawer />
    </div>
  );
}
