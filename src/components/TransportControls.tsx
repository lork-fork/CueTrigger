import { Play, Pause, PauseCircle, RotateCcw } from 'lucide-react';
import { useAppStore } from '../store';
import { audioEngine, useAudioEngineState } from '../audioEngine';
import { usePlaylistEngineState } from '../playlistEngine';

interface TransportControlsProps {
  onResumeAll?: () => void;
}

export default function TransportControls({ onResumeAll }: TransportControlsProps) {
  const { playingIds, pausedIds, isFadingPause } = useAudioEngineState();
  const { isPlaying: isPlaylistPlaying, isPaused: isPlaylistPaused } = usePlaylistEngineState();
  const { globalVolume } = useAppStore();

  const isAnyPlaying = playingIds.length > 0 || isPlaylistPlaying;
  const isAnyPaused = pausedIds.length > 0 || isPlaylistPaused;
  const totalPausedCount = pausedIds.length + (isPlaylistPaused ? 1 : 0);

  // Show Resume & Reset All when nothing is actively playing, at least one item is paused, and not currently fading
  const showResumeReset = !isAnyPlaying && isAnyPaused && !isFadingPause;

  const handleInstantPause = () => {
    audioEngine.instantPause();
  };

  const handleFadePause = () => {
    audioEngine.fadePause(4);
  };

  const handleResume = () => {
    if (onResumeAll) {
      onResumeAll();
    } else {
      audioEngine.resumePlayback(globalVolume);
    }
  };

  const handleResetAll = () => {
    audioEngine.resetAll(globalVolume);
  };

  return (
    <div className="flex items-center gap-3">
      {!showResumeReset ? (
        <>
          <button
            onClick={handleInstantPause}
            disabled={!isAnyPlaying && !isFadingPause}
            className={`px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 transition-all shadow-lg backdrop-blur-sm cursor-pointer ${
              isAnyPlaying || isFadingPause
                ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/30 active:scale-95'
                : 'bg-slate-800/60 text-slate-500 border border-slate-700/50 opacity-60 cursor-not-allowed'
            }`}
            title="Instant pause all playing sounds (including playlist)"
          >
            <Pause size={16} /> Instant Pause
          </button>
          <button
            onClick={handleFadePause}
            disabled={!isAnyPlaying && !isFadingPause}
            className={`relative overflow-hidden px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 transition-all shadow-lg backdrop-blur-sm group cursor-pointer ${
              isAnyPlaying || isFadingPause
                ? 'bg-orange-500/20 hover:bg-orange-500/30 text-orange-400 border border-orange-500/30 active:scale-95'
                : 'bg-slate-800/60 text-slate-500 border border-slate-700/50 opacity-60 cursor-not-allowed'
            }`}
            title="4-second fade out pause (including playlist)"
          >
            {isFadingPause && (
              <div
                className="absolute inset-0 bg-orange-500/30"
                style={{
                  animation: 'wipe-right-to-left 4s linear forwards',
                }}
              />
            )}
            <PauseCircle size={16} className="z-10" /> <span className="z-10">Fade Pause (4s)</span>
          </button>
          {pausedIds.length > 0 && (
            <button
              onClick={handleResetAll}
              className="bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 px-3 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 transition-all active:scale-95 shadow-lg backdrop-blur-sm cursor-pointer"
              title="Reset all cues (leaves playlist intact)"
            >
              <RotateCcw size={15} /> Reset All
            </button>
          )}
        </>
      ) : (
        <>
          <button
            onClick={handleResume}
            className="bg-green-600/30 hover:bg-green-600/40 text-green-400 border border-green-500/40 px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 transition-all active:scale-95 shadow-lg backdrop-blur-sm cursor-pointer animate-pulse"
            title={`Resume ${totalPausedCount} paused sound${totalPausedCount > 1 ? 's' : ''}`}
          >
            <Play size={16} className="fill-current" /> Resume {totalPausedCount > 1 ? `(${totalPausedCount})` : ''}
          </button>
          <button
            onClick={handleResetAll}
            className="bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 transition-all active:scale-95 shadow-lg backdrop-blur-sm cursor-pointer"
            title="Reset all cues (leaves playlist intact)"
          >
            <RotateCcw size={16} /> Reset All
          </button>
        </>
      )}
    </div>
  );
}
