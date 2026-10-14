import React, { useState, useRef, useEffect, useCallback } from 'react';
import { PlaylistTrack } from '../types';
import { useAppStore } from '../store';
import { X, Volume2, Clock, Check, Scissors, Play, Pause, RotateCcw } from 'lucide-react';
import { audioEngine } from '../audioEngine';

interface Props {
  track: PlaylistTrack;
  onClose: () => void;
}

function formatTime(sec: number): string {
  if (isNaN(sec) || sec < 0) return '0:00.0';
  const mins = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return `${mins}:${s < 10 ? '0' : ''}${s}.${ms}`;
}

export default function PlaylistTrackSettingsModal({ track, onClose }: Props) {
  const updatePlaylistTrack = useAppStore((state) => state.updatePlaylistTrack);
  const [name, setName] = useState(track.name);
  const [volume, setVolume] = useState(track.volume ?? 1.0);
  const [trimStart, setTrimStart] = useState(track.trimStart || 0);
  const [trimEnd, setTrimEnd] = useState(track.trimEnd || track.duration || 0);

  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [isLoadingBuffer, setIsLoadingBuffer] = useState(true);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [previewProgress, setPreviewProgress] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const previewGainRef = useRef<GainNode | null>(null);
  const previewStartTimeRef = useRef<number>(0);
  const previewOffsetRef = useRef<number>(0);
  const animFrameRef = useRef<number | null>(null);

  const maxDuration = audioBuffer?.duration || track.duration || 60;

  // Load the audio buffer for waveform rendering
  useEffect(() => {
    let isMounted = true;
    const fetchBuffer = async () => {
      setIsLoadingBuffer(true);
      try {
        let buffer = await audioEngine.loadAudio(track.audioUrl || '', `track-${track.id}`);
        if (!buffer && track.audioUrl) {
          buffer = await audioEngine.loadAudio(track.audioUrl, track.id);
        }
        if (isMounted) {
          if (buffer) {
            setAudioBuffer(buffer);
            if (!track.duration || track.duration <= 0) {
              setTrimEnd(prev => (prev === 0 ? buffer!.duration : prev));
            }
          }
          setIsLoadingBuffer(false);
        }
      } catch (err) {
        console.error('Failed to load waveform buffer:', err);
        if (isMounted) setIsLoadingBuffer(false);
      }
    };

    fetchBuffer();

    return () => {
      isMounted = false;
      stopPreview();
    };
  }, [track.id, track.audioUrl]);

  // Stop any active preview playback
  const stopPreview = useCallback(() => {
    if (previewSourceRef.current) {
      try {
        previewSourceRef.current.stop();
      } catch (e) {}
      previewSourceRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    setIsPreviewPlaying(false);
    setPreviewProgress(0);
  }, []);

  // Toggle preview of the trimmed section
  const togglePreview = useCallback(() => {
    if (isPreviewPlaying) {
      stopPreview();
      return;
    }

    if (!audioBuffer) return;

    audioEngine.init();
    const ctx = audioEngine.context;
    if (!ctx) return;

    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const start = Math.max(0, trimStart);
    const end = Math.min(maxDuration, trimEnd > start ? trimEnd : maxDuration);
    const playLength = Math.max(0.1, end - start);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(volume, ctx.currentTime);

    source.connect(gainNode);
    gainNode.connect(ctx.destination);

    previewSourceRef.current = source;
    previewGainRef.current = gainNode;
    previewStartTimeRef.current = ctx.currentTime;
    previewOffsetRef.current = start;

    source.onended = () => {
      stopPreview();
    };

    source.start(0, start, playLength);
    setIsPreviewPlaying(true);

    const updatePlayhead = () => {
      if (!ctx || !previewSourceRef.current) return;
      const elapsed = ctx.currentTime - previewStartTimeRef.current;
      const currentPos = start + elapsed;
      if (currentPos >= end) {
        stopPreview();
        return;
      }
      setPreviewProgress(currentPos);
      animFrameRef.current = requestAnimationFrame(updatePlayhead);
    };

    animFrameRef.current = requestAnimationFrame(updatePlayhead);
  }, [audioBuffer, isPreviewPlaying, trimStart, trimEnd, maxDuration, volume, stopPreview]);

  // Draw waveform on canvas whenever buffer or trim markers change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Background
    ctx.fillStyle = '#090d16'; // slate-950 deep
    ctx.fillRect(0, 0, width, height);

    // Subtle horizontal center grid line
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    if (!audioBuffer) {
      if (isLoadingBuffer) {
        ctx.fillStyle = '#64748b';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Loading waveform...', width / 2, height / 2);
      }
      return;
    }

    const rawData = audioBuffer.getChannelData(0);
    const totalDuration = audioBuffer.duration;
    const step = Math.ceil(rawData.length / width);
    const amp = (height / 2) * 0.9;

    const startRatio = totalDuration > 0 ? Math.max(0, trimStart / totalDuration) : 0;
    const endRatio = totalDuration > 0 ? Math.min(1, trimEnd / totalDuration) : 1;
    const startX = startRatio * width;
    const endX = endRatio * width;

    // Draw waveform bars with gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#60a5fa'); // blue-400
    gradient.addColorStop(0.5, '#3b82f6'); // blue-500
    gradient.addColorStop(1, '#1d4ed8'); // blue-700

    ctx.fillStyle = gradient;

    for (let i = 0; i < width; i++) {
      let min = 1.0;
      let max = -1.0;
      const offset = i * step;
      for (let j = 0; j < step && offset + j < rawData.length; j++) {
        const val = rawData[offset + j];
        if (val < min) min = val;
        if (val > max) max = val;
      }
      if (min > max) {
        min = 0;
        max = 0;
      }

      // Inside trimmed zone vs outside
      const inTrim = i >= startX && i <= endX;
      ctx.fillStyle = inTrim ? '#38bdf8' : '#334155'; // cyan-400 vs muted slate-700

      const y = (1 + min) * (height / 2);
      const barHeight = Math.max(1.5, (max - min) * amp);
      ctx.fillRect(i, y, 1, barHeight);
    }

    // Shaded dim overlays outside the trimmed section
    ctx.fillStyle = 'rgba(2, 6, 23, 0.72)'; // darkened slate-950
    if (startX > 0) {
      ctx.fillRect(0, 0, startX, height);
    }
    if (endX < width) {
      ctx.fillRect(endX, 0, width - endX, height);
    }

    // Start Trim boundary marker (Green)
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(startX, 0);
    ctx.lineTo(startX, height);
    ctx.stroke();

    // Start Trim flag badge
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(startX, 0, Math.min(24, width - startX), 14);
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('IN', startX + 3, 2);

    // End Trim boundary marker (Red)
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(endX, 0);
    ctx.lineTo(endX, height);
    ctx.stroke();

    // End Trim flag badge
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(Math.max(0, endX - 24), 0, 24, 14);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('OUT', endX - 3, 2);

    // Live preview playhead line (Yellow/White)
    if (isPreviewPlaying && previewProgress >= trimStart && previewProgress <= trimEnd) {
      const playRatio = previewProgress / totalDuration;
      const playX = playRatio * width;
      ctx.strokeStyle = '#facc15'; // yellow-400
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playX, 0);
      ctx.lineTo(playX, height);
      ctx.stroke();

      // Small glowing head
      ctx.fillStyle = '#fef08a';
      ctx.beginPath();
      ctx.arc(playX, 4, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [audioBuffer, isLoadingBuffer, trimStart, trimEnd, isPreviewPlaying, previewProgress]);

  // Click on canvas to seek/set boundary
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !audioBuffer) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    const targetSec = ratio * maxDuration;

    // Pick whichever marker is closest to click
    const distToStart = Math.abs(targetSec - trimStart);
    const distToEnd = Math.abs(targetSec - trimEnd);

    if (distToStart < distToEnd) {
      setTrimStart(Math.max(0, Math.min(targetSec, trimEnd - 0.1)));
    } else {
      setTrimEnd(Math.min(maxDuration, Math.max(trimStart + 0.1, targetSec)));
    }
  };

  const handleSave = () => {
    stopPreview();
    updatePlaylistTrack(track.id, {
      name: name.trim() || track.name,
      volume,
      trimStart: Math.max(0, Math.min(trimStart, trimEnd - 0.1)),
      trimEnd: Math.min(maxDuration, Math.max(trimStart + 0.1, trimEnd)),
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div 
        className="w-full max-w-xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl p-5 flex flex-col gap-4 text-white animate-in fade-in zoom-in-95 duration-150 max-h-[94vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-blue-600/20 text-blue-400 border border-blue-500/30">
              <Scissors size={18} />
            </div>
            <div>
              <h3 className="font-bold text-base text-white">Track Settings & Waveform Trim</h3>
              <p className="text-xs text-slate-400">Trim start/end, adjust volume, and rename track</p>
            </div>
          </div>
          <button
            onClick={() => {
              stopPreview();
              onClose();
            }}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* Track Title */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Track Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="bg-slate-800 text-white px-3 py-2 rounded-lg border border-slate-700 focus:outline-none focus:border-blue-500 text-sm font-medium"
            placeholder="Track title"
          />
        </div>

        {/* Waveform Visualizer Section */}
        <div className="flex flex-col gap-2 p-3 rounded-xl bg-slate-950/80 border border-slate-800/90 shadow-inner">
          <div className="flex justify-between items-center text-xs">
            <span className="font-semibold text-slate-300 flex items-center gap-1.5">
              <Scissors size={14} className="text-cyan-400" /> Audio Waveform & Trimming
            </span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-slate-400">
                Active: <span className="text-cyan-300 font-bold">{formatTime(Math.max(0, trimEnd - trimStart))}</span>
                <span className="text-slate-600 mx-1">/</span>
                <span className="text-slate-400">{formatTime(maxDuration)}</span>
              </span>
            </div>
          </div>

          {/* Interactive Waveform Canvas */}
          <div className="relative rounded-lg overflow-hidden border border-slate-800/80 bg-slate-950 shadow-md">
            <canvas 
              ref={canvasRef} 
              width={800} 
              height={140} 
              onClick={handleCanvasClick}
              className="w-full h-[140px] block cursor-crosshair"
              title="Click anywhere to move the nearest trim marker"
            />
            {/* Quick time legend indicator */}
            <div className="absolute bottom-1 right-2 pointer-events-none text-[9px] font-mono text-slate-500 bg-slate-950/80 px-1.5 py-0.5 rounded border border-slate-800/60">
              Click waveform to adjust markers
            </div>
          </div>

          {/* Preview Playback Controls Bar */}
          <div className="flex items-center justify-between pt-1 text-xs">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={togglePreview}
                disabled={!audioBuffer}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold text-xs transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shadow-sm ${
                  isPreviewPlaying
                    ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 border border-amber-400'
                    : 'bg-blue-600 hover:bg-blue-500 text-white border border-blue-500'
                }`}
                title={isPreviewPlaying ? 'Pause preview' : 'Play trimmed section'}
              >
                {isPreviewPlaying ? (
                  <>
                    <Pause size={14} /> Stop Preview
                  </>
                ) : (
                  <>
                    <Play size={14} className="fill-current ml-0.5" /> Preview Trimmed
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  stopPreview();
                  setTrimStart(0);
                  setTrimEnd(maxDuration);
                }}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer text-xs"
                title="Reset trim markers to full audio length"
              >
                <RotateCcw size={13} /> Reset to Full
              </button>
            </div>

            <div className="flex items-center gap-3 font-mono text-[11px]">
              <span className="flex items-center gap-1 text-green-400">
                <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                Start: <strong className="text-white">{formatTime(trimStart)}</strong>
              </span>
              <span className="flex items-center gap-1 text-red-400">
                <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
                End: <strong className="text-white">{formatTime(trimEnd)}</strong>
              </span>
            </div>
          </div>

          {/* Start & End Dual Sliders */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-800/80">
            {/* Start Time Slider */}
            <div className="flex flex-col gap-1">
              <div className="flex justify-between items-center text-[11px] text-slate-400">
                <span className="text-green-400 font-semibold flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400" /> Start Time (IN)
                </span>
                <span className="font-mono font-bold text-white">{formatTime(trimStart)}</span>
              </div>
              <input
                type="range"
                min="0"
                max={Math.max(0.1, trimEnd - 0.1)}
                step="0.05"
                value={trimStart}
                onChange={(e) => {
                  stopPreview();
                  setTrimStart(parseFloat(e.target.value));
                }}
                className="w-full accent-green-500 cursor-pointer h-2 bg-slate-800 rounded-lg"
              />
            </div>

            {/* End Time Slider */}
            <div className="flex flex-col gap-1">
              <div className="flex justify-between items-center text-[11px] text-slate-400">
                <span className="text-red-400 font-semibold flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400" /> End Time (OUT)
                </span>
                <span className="font-mono font-bold text-white">{formatTime(trimEnd)}</span>
              </div>
              <input
                type="range"
                min={Math.min(maxDuration, trimStart + 0.1)}
                max={maxDuration}
                step="0.05"
                value={trimEnd}
                onChange={(e) => {
                  stopPreview();
                  setTrimEnd(parseFloat(e.target.value));
                }}
                className="w-full accent-red-500 cursor-pointer h-2 bg-slate-800 rounded-lg"
              />
            </div>
          </div>
        </div>

        {/* Volume Slider */}
        <div className="flex flex-col gap-1.5 p-3 rounded-xl bg-slate-950/60 border border-slate-800/80">
          <div className="flex justify-between items-center text-xs">
            <span className="font-semibold text-slate-300 flex items-center gap-1.5">
              <Volume2 size={15} className="text-blue-400" /> Track Volume
            </span>
            <span className={`font-mono font-bold ${volume > 1.0 ? 'text-amber-400' : 'text-slate-300'}`}>
              {Math.round(volume * 100)}%
              {volume > 1.0 && <span className="ml-1 text-[10px] text-amber-500 font-sans font-normal">(Boost)</span>}
            </span>
          </div>
          <input
            type="range"
            min="0"
            max="1.5"
            step="0.05"
            value={volume}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setVolume(v);
              if (previewGainRef.current && audioEngine.context) {
                previewGainRef.current.gain.setValueAtTime(v, audioEngine.context.currentTime);
              }
            }}
            className="w-full accent-blue-500 cursor-pointer h-2 bg-slate-800 rounded-lg"
          />
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
          <button
            onClick={() => {
              stopPreview();
              onClose();
            }}
            className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-1.5 shadow-lg shadow-blue-600/30 transition-all cursor-pointer"
          >
            <Check size={16} /> Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

