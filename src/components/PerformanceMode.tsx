import { useEffect, useState, useRef } from 'react';
import { useAppStore } from '../store';
import { TriggerNodeData } from '../types';
import { audioEngine, useAudioEngineState } from '../audioEngine';
import { AppNode } from '../store';
import { Edge } from '@xyflow/react';
import { Move, Volume2, Sliders, Play, Pause, X, Palette, AlertTriangle } from 'lucide-react';
import TransportControls from './TransportControls';
import FitTitle from './FitTitle';
import { getTriggerSegments, executeSequence } from '../sequenceRunner';
import { SQUARE_COLORS, getSquareBorderColor, isLightColor } from '../colors';

// Ignore a second press of the same cue within this window (double-taps, key bounce)
const RETRIGGER_LOCKOUT_MS = 250;

// Only fields you type into should swallow cue keys; sliders, checkboxes and buttons should not
const TEXT_INPUT_TYPES = new Set(['text', 'number', 'search', 'email', 'password', 'url', 'tel']);
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') return TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
  return false;
}

// Names of audio in this cue that can't play (no file, or the file failed to load)
export function getMissingAudio(triggerId: string, nodes: AppNode[], edges: Edge[]): string[] {
  const { segments } = getTriggerSegments(triggerId, nodes, edges);
  return segments
    .filter(seg => !seg.audioUrl || audioEngine.getAudioStatus(seg.nodeId) === 'missing')
    .map(seg => seg.audioName || 'Audio node with no file');
}

// Rename a cue from its tile settings. Enter or clicking away saves, Escape cancels.
// It's a text field, so cue keys and Space are ignored while typing in it.
function TileNameInput({ title, onRename }: { title: string; onRename: (title: string) => void }) {
  const [draft, setDraft] = useState(title);
  const cancelledRef = useRef(false);

  useEffect(() => {
    setDraft(title);
  }, [title]);

  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    const trimmed = draft.trim();
    if (trimmed && trimmed !== title) onRename(trimmed);
    else setDraft(title);
  };

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => {
        cancelledRef.current = false;
        e.currentTarget.select();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelledRef.current = true;
          setDraft(title);
          e.currentTarget.blur();
        }
      }}
      onBlur={commit}
      placeholder="Cue name"
      title="Rename this cue"
      className="font-bold text-blue-300 bg-slate-900 border border-slate-700 hover:border-slate-600 focus:border-blue-500 focus:outline-none rounded px-1.5 py-0.5 text-xs min-w-0 flex-1 mr-1"
    />
  );
}

function formatTime(sec: number): string {
  if (isNaN(sec) || sec < 0) return '0:00';
  const mins = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${mins}:${s < 10 ? '0' : ''}${s}`;
}

export default function PerformanceMode() {
  const { nodes, edges, normalizeTriggerIndices, moveTriggerNode, globalVolume, updateNodeData } = useAppStore();
  const { playingIds, pausedIds } = useAudioEngineState();
  const [isRearrangeMode, setIsRearrangeMode] = useState(false);
  const [openSettingsTileId, setOpenSettingsTileId] = useState<string | null>(null);
  const [timelinePositions, setTimelinePositions] = useState<Record<string, number>>({});
  const requestRef = useRef<number>();
  const lastGoRef = useRef<Map<string, number>>(new Map());
  const isAnythingPlaying = playingIds.length > 0;

  useEffect(() => {
    // Update timeline positions; only animate while something is playing, and only re-render on change
    const readPositions = () => {
      setTimelinePositions(prev => {
        let changed = false;
        const posMap: Record<string, number> = {};
        nodes.forEach(n => {
          if (n.type === 'triggerNode') {
            const pos = audioEngine.getTriggerCurrentTime(n.id);
            posMap[n.id] = pos;
            if (Math.abs((prev[n.id] ?? -1) - pos) > 0.05) changed = true;
          }
        });
        if (Object.keys(prev).length !== Object.keys(posMap).length) changed = true;
        return changed ? posMap : prev;
      });
    };
    readPositions();
    if (!isAnythingPlaying) return;
    const updateLoop = () => {
      readPositions();
      requestRef.current = requestAnimationFrame(updateLoop);
    };
    requestRef.current = requestAnimationFrame(updateLoop);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [nodes, isAnythingPlaying, pausedIds]);

  useEffect(() => {
    normalizeTriggerIndices();
  }, [nodes.length, normalizeTriggerIndices]);

  const triggers = nodes.filter((n) => n.type === 'triggerNode');

  const keyCounts = new Map<string, number>();
  triggers.forEach((t) => {
    const key = ((t.data as TriggerNodeData).keyTrigger || '').trim().toLowerCase();
    if (key) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  });
  const duplicateKeys = new Set([...keyCounts].filter(([, n]) => n > 1).map(([k]) => k));

  const missingByTrigger = new Map(triggers.map((t) => [t.id, getMissingAudio(t.id, nodes, edges)]));
  const cuesWithMissing = triggers.filter((t) => (missingByTrigger.get(t.id) ?? []).length > 0);

  const handleTileClick = async (trigger: AppNode) => {
    if (isRearrangeMode) return;

    const nowMs = performance.now();
    const lastGo = lastGoRef.current.get(trigger.id) ?? -Infinity;
    if (nowMs - lastGo < RETRIGGER_LOCKOUT_MS) return;
    lastGoRef.current.set(trigger.id, nowMs);

    audioEngine.init();
    if (audioEngine.context && audioEngine.context.state === 'suspended') {
      await audioEngine.context.resume().catch(() => {});
    }

    const state = audioEngine.getTriggerState(trigger.id);
    const data = trigger.data as TriggerNodeData;

    if (state === 'playing') {
      // Pause this cue
      audioEngine.pauseTrigger(trigger.id);
    } else if (state === 'paused') {
      // Resume this cue from its paused timestamp
      if (data.behavior === 'cut') {
        audioEngine.cutOtherTriggers(trigger.id, 0.04);
      }
      const currentPos = audioEngine.getTriggerCurrentTime(trigger.id);
      audioEngine.resumeTrigger(trigger.id);
      executeSequence(trigger.id, currentPos, false);
    } else {
      // Idle cue: start it!
      if (data.behavior === 'cut') {
        audioEngine.cutOtherTriggers(trigger.id, 0.04);
      }
      executeSequence(trigger.id, 0, false);
    }
  };

  const handleResumeAll = () => {
    audioEngine.resumePlayback(globalVolume);
  };

  const handleTimelineSeek = (triggerId: string, newTime: number) => {
    const state = audioEngine.getTriggerState(triggerId);
    if (state === 'paused') {
      // While paused, update the frozen position without auto-starting playback
      audioEngine.setTriggerTimelinePosition(triggerId, newTime);
      setTimelinePositions(prev => ({ ...prev, [triggerId]: newTime }));
    } else if (state === 'playing') {
      // While playing, seek and smoothly continue playing
      audioEngine.stopTrigger(triggerId);
      executeSequence(triggerId, newTime, false);
    } else {
      executeSequence(triggerId, newTime, false);
    }
  };

  const handleBehaviorChange = (triggerId: string, behavior: TriggerNodeData['behavior']) => {
    updateNodeData(triggerId, { behavior });
    audioEngine.setTriggerDuck(triggerId, behavior === 'duck');
  };

  const handleVolumeBoostChange = (triggerId: string, boost: number) => {
    updateNodeData(triggerId, { volumeBoost: boost });
    audioEngine.setTriggerVolumeBoost(triggerId, boost);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Holding a key auto-repeats; that must not toggle the cue
      if (e.repeat) return;
      // Leave browser/OS shortcuts (Cmd+R, Ctrl+S...) alone
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextEntry(e.target)) return;

      // Space pauses everything, Shift+Space fade-pauses (also stops Space from clicking a focused button)
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        const somethingPlaying =
          audioEngine.getPlayingTriggerIds().length > 0 || Boolean(audioEngine.playlistBridge?.isPlaying());
        if (e.shiftKey) {
          if (somethingPlaying) audioEngine.fadePause(4);
        } else if (somethingPlaying || audioEngine.isFadingPause) {
          audioEngine.instantPause();
        }
        return;
      }

      if (isRearrangeMode) return;

      const matchedTrigger = triggers.find(
        (t) => {
          const key = (t.data as TriggerNodeData).keyTrigger;
          return key && key.trim().length > 0 && key.toLowerCase() === e.key.toLowerCase();
        }
      );
      if (matchedTrigger) {
        e.preventDefault();
        handleTileClick(matchedTrigger);
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [triggers, edges, nodes, isRearrangeMode, globalVolume, playingIds, pausedIds]);

  const maxIndex = triggers.reduce((max, node) => {
    const idx = node.data.performanceIndex as number || 0;
    return Math.max(max, idx);
  }, 0);

  const gridSize = isRearrangeMode ? Math.max(48, maxIndex + 17) : maxIndex + 1;

  return (
    <div className="flex-1 bg-slate-900 p-8 overflow-y-auto flex flex-col">
      <div className="relative flex flex-wrap justify-between items-center gap-4 mb-6">
        <h2 className="text-2xl font-bold text-white">Performance Grid</h2>

        {/* Center Transport Controls */}
        <div className="sm:absolute sm:left-1/2 sm:-translate-x-1/2">
          <TransportControls onResumeAll={handleResumeAll} />
        </div>

        <button 
          onClick={() => setIsRearrangeMode(!isRearrangeMode)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold transition-colors cursor-pointer ${
             isRearrangeMode ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg' : 'bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700'
          }`}
        >
          <Move size={18} /> {isRearrangeMode ? 'Done Rearranging' : 'Rearrange Grid'}
        </button>
      </div>

      {cuesWithMissing.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/60 bg-red-950/60 px-4 py-2.5 text-sm text-red-200">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-400" />
          <div>
            <span className="font-bold text-red-100">
              {cuesWithMissing.length} cue{cuesWithMissing.length > 1 ? 's have' : ' has'} missing audio:
            </span>{' '}
            {cuesWithMissing
              .map((t) => `${(t.data as TriggerNodeData).title || 'Untitled'} (${(missingByTrigger.get(t.id) ?? []).join(', ')})`)
              .join('; ')}
            . Re-add the files in the Editor before the show.
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-4">
        {Array.from({ length: gridSize }).map((_, index) => {
          const trigger = triggers.find(t => (t.data.performanceIndex as number) === index);

          if (!trigger) {
            if (!isRearrangeMode) {
              return <div key={`empty-${index}`} className="aspect-square" />;
            }
            return (
              <div 
                key={`empty-${index}`} 
                className="aspect-square border-2 border-dashed border-slate-700 hover:border-slate-500 rounded-xl transition-colors"
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const nodeId = e.dataTransfer.getData('nodeId');
                  if (nodeId) moveTriggerNode(nodeId, index);
                }}
              />
            );
          }

          const data = trigger.data as TriggerNodeData;
          const isPlaying = playingIds.includes(trigger.id);
          const isTilePaused = pausedIds.includes(trigger.id);
          const isSettingsOpen = openSettingsTileId === trigger.id;
          const triggerBoost = data.volumeBoost ?? 1.0;
          const { totalDuration: totalSeqDuration } = getTriggerSegments(trigger.id, nodes, edges);
          const currentTimelinePos = timelinePositions[trigger.id] || 0;
          const tileColor = data.color || '#1e293b';
          const borderColor = getSquareBorderColor(tileColor);
          // Overlays and text flip to dark on light tile colors so they stay visible
          const isLightTile = isLightColor(tileColor);
          const contrastRgb = isLightTile ? '0, 0, 0' : '255, 255, 255';
          
          return (
            <div 
              key={trigger.id}
              className={`w-full aspect-square relative ${isRearrangeMode ? 'cursor-grab active:cursor-grabbing' : ''}`}
              draggable={isRearrangeMode}
              onDragStart={(e) => {
                e.dataTransfer.setData('nodeId', trigger.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (isRearrangeMode) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }
              }}
              onDrop={(e) => {
                if (isRearrangeMode) {
                  e.preventDefault();
                  const nodeId = e.dataTransfer.getData('nodeId');
                  if (nodeId && nodeId !== trigger.id) moveTriggerNode(nodeId, index);
                }
              }}
            >
              <button
                onClick={() => handleTileClick(trigger)}
                disabled={isRearrangeMode}
                style={
                  isRearrangeMode
                    ? undefined
                    : isPlaying
                      ? { backgroundColor: tileColor, borderColor: `rgb(${contrastRgb})` }
                      : { backgroundColor: tileColor, borderColor: borderColor }
                }
                className={`w-full h-full transition-all border-2 rounded-xl flex flex-col items-center justify-center p-3 shadow-lg relative overflow-hidden group select-none text-left ${
                  isRearrangeMode
                    ? 'border-blue-500 bg-slate-700 pointer-events-none'
                    : isPlaying || isTilePaused
                      ? 'cursor-pointer'
                      : 'hover:brightness-110 active:brightness-90 cursor-pointer'
                }`}
              >
                {/* Playing: a contrasting glow pulses over the tile's own color */}
                {isPlaying && (
                  <div
                    className="absolute inset-0 z-10 rounded-[10px] cue-pulse"
                    style={{
                      backgroundColor: `rgba(${contrastRgb}, 0.18)`,
                      boxShadow: `inset 0 0 0 3px rgba(${contrastRgb}, 0.85), inset 0 0 28px rgba(${contrastRgb}, 0.45)`,
                    }}
                  />
                )}

                {/* Paused: slow VHS scan lines over the tile's own color */}
                {isTilePaused && (
                  <div className="absolute inset-0 z-10 overflow-hidden rounded-xl pointer-events-none">
                    <div className="absolute inset-0 vhs-scanlines opacity-70" />
                    <div
                      className="absolute left-0 right-0 h-6 vhs-tracking-bar"
                      style={{ background: `linear-gradient(to bottom, transparent, rgba(${contrastRgb}, 0.22), transparent)` }}
                    />
                    <div className="absolute bottom-2.5 left-2.5 px-2 py-0.5 bg-black/75 rounded border border-cyan-500/50 font-mono text-[10px] tracking-widest text-cyan-300 font-bold uppercase drop-shadow-[0_0_6px_rgba(34,211,238,0.8)]">
                      <span className="paused-text-pulse inline-block">PAUSED</span>
                    </div>
                  </div>
                )}

                {/* Corner speaker icon when playing */}
                {isPlaying && (
                  <Volume2 size={20} className={`absolute top-3 right-10 opacity-85 z-10 ${isLightTile ? 'text-slate-900' : 'text-white'}`} />
                )}

                {/* Top-Left: Trigger Key Badge & Mode Badge */}
                <div className="absolute top-2.5 left-2.5 flex items-center gap-1 z-20 pointer-events-none">
                  {data.keyTrigger && (
                    <span className={`px-2 py-0.5 rounded font-mono text-xs font-bold border shadow-sm ${
                      isPlaying
                        ? 'bg-green-700 text-white border-green-500'
                        : isTilePaused
                          ? 'bg-slate-900 text-cyan-300 border-cyan-600/60'
                          : 'bg-slate-900 text-green-400 border-slate-700'
                    }`}>
                      {data.keyTrigger.toUpperCase()}
                    </span>
                  )}
                  {data.keyTrigger && duplicateKeys.has(data.keyTrigger.toLowerCase()) && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-red-600 text-white border border-red-400 shadow-sm" title="Another cue uses this key; only one of them will fire">
                      DUP KEY
                    </span>
                  )}
                  {(missingByTrigger.get(trigger.id) ?? []).length > 0 && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-red-600 text-white border border-red-400 shadow-sm" title={`Missing: ${(missingByTrigger.get(trigger.id) ?? []).join(', ')}`}>
                      MISSING
                    </span>
                  )}
                  {data.behavior === 'duck' && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-sky-500/20 text-sky-300 border border-sky-500/40 shadow-sm" title="Ducks all other audio, including the playlist, while it plays">
                      DUCK
                    </span>
                  )}
                  {data.behavior === 'cut' && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm" title="Cut Previous Mode">
                      CUT
                    </span>
                  )}
                </div>

                {/* Main Title centered */}
                <FitTitle
                  text={data.title || 'Untitled'}
                  className={isLightTile && !isRearrangeMode ? 'text-slate-900' : 'text-white'}
                />

                {/* Hover Action Overlays */}
                {/* Playing: Hover shows Pause symbol */}
                {isPlaying && (
                  <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-[1px] opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center transition-opacity z-20 pointer-events-none">
                    <div className="p-3 rounded-full bg-slate-900/85 border border-amber-500/60 text-amber-400 shadow-xl">
                      <Pause size={28} />
                    </div>
                    <span className="text-[11px] font-bold text-amber-300 mt-1 uppercase tracking-wider">Pause</span>
                  </div>
                )}

                {/* Paused: Hover shows Play / Resume symbol */}
                {isTilePaused && (
                  <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-[1px] opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center transition-opacity z-20 pointer-events-none">
                    <div className="p-3 rounded-full bg-slate-900/85 border border-green-500/60 text-green-400 shadow-xl">
                      <Play size={28} className="fill-current ml-0.5" />
                    </div>
                    <span className="text-[11px] font-bold text-green-300 mt-1 uppercase tracking-wider">Resume</span>
                  </div>
                )}
              </button>

              {/* Top-Right: Settings Icon Toggle */}
              {!isRearrangeMode && (
                <div className="absolute top-2.5 right-2.5 z-20">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenSettingsTileId(isSettingsOpen ? null : trigger.id);
                    }}
                    className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                      isSettingsOpen
                        ? 'bg-blue-600 text-white shadow-md'
                        : 'text-slate-400 hover:text-white hover:bg-slate-700/80'
                    }`}
                    title="Volume & Timeline Settings"
                  >
                    <Sliders size={15} />
                  </button>
                </div>
              )}

              {/* Settings Overlay for this tile */}
              {isSettingsOpen && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute inset-0 z-30 bg-slate-950/95 backdrop-blur-md rounded-xl p-3 flex flex-col justify-between border-2 border-blue-500/80 shadow-2xl overflow-y-auto"
                >
                  {/* Settings Header */}
                  <div className="flex justify-between items-center text-xs pb-1 border-b border-slate-800">
                    <TileNameInput
                      title={data.title || ''}
                      onRename={(title) => updateNodeData(trigger.id, { title })}
                    />
                    <button
                      onClick={() => setOpenSettingsTileId(null)}
                      className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
                      title="Close Settings"
                    >
                      <X size={15} />
                    </button>
                  </div>

                  {/* Settings Middle: Vertical Volume Slider + Quick Play/Pause */}
                  <div className="flex items-center justify-around my-auto py-1">
                    {/* Vertical Volume Slider with boost past 100% */}
                    <div className="flex flex-col items-center gap-1">
                      <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                        Volume
                      </span>
                      <div className="h-24 flex items-center justify-center">
                        <input
                          type="range"
                          min="0"
                          max="1.5"
                          step="0.05"
                          value={triggerBoost}
                          onChange={(e) => handleVolumeBoostChange(trigger.id, parseFloat(e.target.value))}
                          style={{
                            writingMode: 'vertical-lr',
                            direction: 'rtl',
                          }}
                          className="h-24 w-3 accent-blue-500 cursor-pointer"
                        />
                      </div>
                      <div className="text-xs font-mono font-bold text-center">
                        <span className={triggerBoost > 1.0 ? 'text-amber-400' : 'text-slate-300'}>
                          {Math.round(triggerBoost * 100)}%
                        </span>
                        {triggerBoost > 1.0 && (
                          <span className="text-[9px] block text-amber-500 font-sans leading-none">Boost</span>
                        )}
                      </div>
                    </div>

                    {/* Quick Play/Pause inside settings */}
                    <div className="flex flex-col items-center gap-1.5">
                      <button
                        onClick={() => handleTileClick(trigger)}
                        className={`p-3 rounded-full border shadow-lg transition-transform active:scale-95 cursor-pointer ${
                          isPlaying
                            ? 'bg-amber-500/20 text-amber-400 border-amber-500/40 hover:bg-amber-500/30'
                            : isTilePaused
                              ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 hover:bg-cyan-500/30'
                              : 'bg-green-600/30 text-green-400 border-green-500/40 hover:bg-green-600/40'
                        }`}
                        title={isPlaying ? "Pause" : isTilePaused ? "Resume" : "Play"}
                      >
                        {isPlaying ? <Pause size={20} /> : <Play size={20} className="fill-current ml-0.5" />}
                      </button>
                      <span className={`text-[10px] uppercase tracking-widest font-semibold ${
                        isPlaying ? 'text-amber-400' : isTilePaused ? 'text-cyan-300' : 'text-slate-400'
                      }`}>
                        {isPlaying ? "Playing" : isTilePaused ? "Paused" : "Ready"}
                      </span>
                    </div>
                  </div>

                  {/* Settings Bottom: Color Customization, Mode Selector & Horizontal Timeline Slider */}
                  <div className="flex flex-col gap-2 pt-1 border-t border-slate-800">
                    {/* Square Color Customization */}
                    <div className="flex flex-col gap-1">
                      <div className="flex justify-between items-center text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                        <span className="flex items-center gap-1">
                          <Palette size={11} className="text-slate-400" /> Color
                        </span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-mono text-slate-400">{tileColor}</span>
                          <label 
                            className="w-4 h-4 rounded-md border border-white/40 cursor-pointer overflow-hidden shadow-sm flex items-center justify-center relative hover:scale-110 transition-transform"
                            title="Custom color picker"
                          >
                            <input
                              type="color"
                              value={tileColor}
                              onChange={(e) => updateNodeData(trigger.id, { color: e.target.value })}
                              className="opacity-0 absolute inset-0 cursor-pointer w-full h-full"
                            />
                            <span className="w-full h-full" style={{ backgroundColor: tileColor }} />
                          </label>
                        </div>
                      </div>
                      <div className="grid grid-cols-8 gap-1 pt-0.5">
                        {SQUARE_COLORS.map((c) => (
                          <button
                            key={c.value}
                            type="button"
                            onClick={() => updateNodeData(trigger.id, { color: c.value })}
                            className={`w-full aspect-square rounded border transition-transform hover:scale-120 cursor-pointer ${
                              tileColor.toLowerCase() === c.value.toLowerCase() ? 'ring-2 ring-white scale-110 border-white' : 'border-black/50'
                            }`}
                            style={{ backgroundColor: c.value }}
                            title={c.name}
                          />
                        ))}
                      </div>
                    </div>

                    {/* Trigger Mode Selector */}
                    <div className="flex flex-col gap-1">
                      <div className="flex justify-between items-center text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                        <span>Mode</span>
                        <span className={data.behavior === 'cut' ? 'text-amber-400' : data.behavior === 'duck' ? 'text-sky-400' : 'text-blue-400'}>
                          {data.behavior === 'cut' ? 'Cut Previous' : data.behavior === 'duck' ? 'Duck Others' : 'Overlay'}
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-1 p-0.5 bg-slate-900 rounded-lg border border-slate-800">
                        <button
                          type="button"
                          onClick={() => handleBehaviorChange(trigger.id, 'overlay')}
                          className={`py-1 px-1.5 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                            data.behavior !== 'cut' && data.behavior !== 'duck'
                              ? 'bg-blue-600 text-white shadow-sm'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          Overlay
                        </button>
                        <button
                          type="button"
                          onClick={() => handleBehaviorChange(trigger.id, 'duck')}
                          title="Lower all other cues and the playlist while this cue plays"
                          className={`py-1 px-1.5 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                            data.behavior === 'duck'
                              ? 'bg-sky-600 text-white shadow-sm'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          Duck
                        </button>
                        <button
                          type="button"
                          onClick={() => handleBehaviorChange(trigger.id, 'cut')}
                          className={`py-1 px-1.5 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                            data.behavior === 'cut'
                              ? 'bg-amber-600 text-white shadow-sm'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          Cut
                        </button>
                      </div>
                    </div>

                    {/* Timeline Slider */}
                    <div className="flex flex-col gap-1">
                      <div className="flex justify-between items-center text-[10px] font-mono text-slate-400">
                        <span>Timeline</span>
                        <span className="text-white font-bold">
                          {formatTime(currentTimelinePos)} / {formatTime(totalSeqDuration)}
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max={totalSeqDuration || 1}
                        step="0.1"
                        value={Math.min(totalSeqDuration || 1, currentTimelinePos)}
                        onChange={(e) => handleTimelineSeek(trigger.id, parseFloat(e.target.value))}
                        className="w-full accent-blue-500 cursor-pointer h-2 bg-slate-800 rounded-lg"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      
      {triggers.length === 0 && (
        <div className="flex h-full items-center justify-center text-slate-500 mt-10">
          No triggers created yet. Switch to Editor mode to add nodes.
        </div>
      )}
    </div>
  );
}

