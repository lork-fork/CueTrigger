import React, { useEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { useAppStore } from '../../store';
import { AudioNodeData } from '../../types';
import { Settings, Scissors, Upload, Play, Square } from 'lucide-react';
import { audioEngine } from '../../audioEngine';
import TrimModal from '../TrimModal';
import NumberField from '../NumberField';
import { saveAudioBlob } from '../../storage';

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const mins = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${mins}:${s < 10 ? '0' : ''}${s}`;
}

export default function AudioNode({ id, data, isConnectable, selected }: { id: string; data: AudioNodeData; isConnectable: boolean; selected?: boolean }) {
  const updateNodeData = useAppStore((state) => state.updateNodeData);
  const mode = useAppStore((state) => state.mode);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const previewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showTrimModal, setShowTrimModal] = useState(false);
  // Preview scrubber: position in real seconds from the trimmed start, ignoring start delay
  const [previewPos, setPreviewPos] = useState(0);
  const previewAnchorRef = useRef<{ startTime: number; seek: number } | null>(null);
  const previewPosRef = useRef(0);
  previewPosRef.current = previewPos;

  const rate = data.pitch > 0 ? data.pitch : 1;
  const passLength = Math.max(0, ((data.trimEnd > data.trimStart ? data.trimEnd : data.duration) - (data.trimStart || 0)) / rate);
  const passes = data.loopCount > 0 ? data.loopCount + 1 : 1;
  const previewTotal = data.loopCount === -1 ? passLength : passLength * passes;

  // Follow the preview while it plays
  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    const tick = () => {
      const anchor = previewAnchorRef.current;
      if (anchor && audioEngine.context) {
        let pos = anchor.seek + Math.max(0, audioEngine.context.currentTime - anchor.startTime);
        if (data.loopCount === -1 && passLength > 0) pos %= passLength;
        setPreviewPos(Math.min(previewTotal, pos));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, passLength, previewTotal, data.loopCount]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await saveAudioBlob(id, file);
      const url = URL.createObjectURL(file);
      // Drop the old file's decoded audio, otherwise the cue keeps playing it
      audioEngine.invalidateAudio(id, data.audioUrl);
      const buffer = await audioEngine.loadAudio(url, id);

      updateNodeData(id, {
        audioUrl: url,
        audioName: file.name,
        duration: buffer ? buffer.duration : 0,
        trimEnd: buffer ? buffer.duration : 0
      });
    }
  };

  const stopPreview = () => {
    // Stop only this preview, never the live cues
    const source = previewSourceRef.current;
    previewSourceRef.current = null;
    if (source) audioEngine.stopSource(source);
  };

  const startPreview = async (fromSeconds: number) => {
    if (!data.audioUrl) return;
    const buffer = await audioEngine.loadAudio(data.audioUrl, id);
    if (!buffer || !audioEngine.context) return;
    stopPreview();
    // A preview is a quick listen, so it always ignores the start delay
    const previewData = { ...data, startDelay: 0 };
    const source = audioEngine.playAudio(buffer, previewData, 'overlay', () => {
      if (previewSourceRef.current !== source) return;
      previewSourceRef.current = null;
      setIsPlaying(false);
      setPreviewPos(0);
    }, undefined, 0, fromSeconds);
    previewSourceRef.current = source;
    previewAnchorRef.current = {
      startTime: audioEngine.context.currentTime + (previewData.startDelay || 0),
      seek: fromSeconds,
    };
    setIsPlaying(Boolean(source));
  };

  const togglePlay = async () => {
    if (isPlaying) {
      stopPreview();
      setIsPlaying(false);
    } else {
      await startPreview(previewPosRef.current >= previewTotal ? 0 : previewPosRef.current);
    }
  };

  const handleScrub = (seconds: number) => {
    setPreviewPos(seconds);
    if (isPlaying) startPreview(seconds);
  };

  // Stop the preview if the node is removed
  useEffect(() => () => stopPreview(), []);

  if (mode === 'performance') return null;

  return (
    <>
      <div className={`bg-slate-800 border-2 border-blue-500 rounded-lg shadow-xl text-white min-w-[240px] overflow-hidden transition-all ${selected ? 'ring-4 ring-blue-400 ring-offset-2 ring-offset-slate-950' : ''}`}>
        <Handle
          type="target"
          position={Position.Left}
          isConnectable={isConnectable}
          className="w-3 h-3 bg-blue-500"
        />

        <div className="custom-drag-handle cursor-grab active:cursor-grabbing bg-slate-900 p-2 flex justify-between items-center border-b border-slate-700">
          <span className="font-bold text-sm truncate max-w-[150px] pointer-events-none" title={data.audioName || 'Empty Audio Node'}>
            {data.audioName || 'Load Audio...'}
          </span>
          <div className="flex gap-1 cursor-default">
             {data.audioUrl && (
               <button onClick={togglePlay} className="p-1 hover:bg-slate-700 rounded text-blue-400 nodrag">
                 {isPlaying ? <Square size={16} /> : <Play size={16} />}
               </button>
             )}
            <button onClick={() => setShowSettings(!showSettings)} className="p-1 hover:bg-slate-700 rounded text-slate-400 nodrag">
              <Settings size={16} />
            </button>
          </div>
        </div>

        <div className="p-3 flex flex-col gap-3 nodrag cursor-default">
          <input type="file" accept="audio/*" className="hidden" ref={fileInputRef} onChange={handleFileChange} />

          {!data.audioUrl && (
            <div className="flex justify-center">
               <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded text-sm transition-colors">
                  <Upload size={14} /> Upload File
               </button>
            </div>
          )}

          {data.audioUrl && (
            <>
              <div className="flex flex-col gap-1">
                <div className="flex justify-between text-xs text-slate-400">
                  <span>Volume</span>
                  <span>{Math.round(data.volume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.01"
                  value={data.volume}
                  onChange={(e) => updateNodeData(id, { volume: parseFloat(e.target.value) })}
                  className="w-full accent-blue-500"
                />
              </div>

              {showSettings && (
                 <div className="flex flex-col gap-3 mt-2 border-t border-slate-700 pt-3">
                   <div className="flex flex-col gap-1">
                      <div className="flex justify-between items-center text-xs text-slate-400">
                        <span className="flex items-center gap-1.5">
                          <button
                            onClick={togglePlay}
                            className="p-0.5 hover:bg-slate-700 rounded text-blue-400"
                            title={isPlaying ? 'Stop preview' : 'Preview from here'}
                          >
                            {isPlaying ? <Square size={12} /> : <Play size={12} />}
                          </button>
                          Preview
                        </span>
                        <span className="font-mono">
                          <span className="text-white">{formatTime(previewPos)}</span> / {formatTime(previewTotal)}
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max={previewTotal || 1}
                        step="0.05"
                        value={Math.min(previewPos, previewTotal || 1)}
                        onChange={(e) => handleScrub(parseFloat(e.target.value))}
                        className="w-full accent-blue-500 cursor-pointer"
                      />
                    </div>

                   <div className="flex flex-col gap-1">
                      <div className="flex justify-between text-xs text-slate-400">
                        <span>Pitch</span>
                        <span>{data.pitch.toFixed(2)}x</span>
                      </div>
                      <input
                        type="range"
                        min="0.5"
                        max="2"
                        step="0.01"
                        value={data.pitch}
                        onChange={(e) => updateNodeData(id, { pitch: parseFloat(e.target.value) })}
                        className="w-full accent-blue-400"
                      />
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <label className="text-xs text-slate-400">Loop</label>
                      <select
                        value={data.loopCount}
                        onChange={(e) => updateNodeData(id, { loopCount: parseInt(e.target.value) })}
                        className="bg-slate-900 text-xs p-1 rounded border border-slate-600 w-20"
                      >
                        <option value={0}>None</option>
                        <option value={-1}>Infinite</option>
                        <option value={1}>1x</option>
                        <option value={2}>2x</option>
                        <option value={3}>3x</option>
                      </select>
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-slate-400">Start Delay (s)</label>
                      <NumberField
                        min={0}
                        step={0.1}
                        fallback={0}
                        value={data.startDelay || 0}
                        onChange={(v) => updateNodeData(id, { startDelay: v })}
                        className="bg-slate-900 text-xs p-1 rounded border border-slate-600 w-full"
                      />
                    </div>

                    <div className="flex gap-2 mt-2">
                      <button
                         onClick={() => setShowTrimModal(true)}
                         className="flex-1 flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-600 text-slate-200 px-3 py-2 rounded text-xs transition-colors"
                      >
                         <Scissors size={14} /> Edit / Trim
                      </button>
                      <button
                         onClick={() => fileInputRef.current?.click()}
                         className="flex-1 flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-600 text-slate-200 px-3 py-2 rounded text-xs transition-colors"
                      >
                         <Upload size={14} /> Replace
                      </button>
                    </div>
                 </div>
              )}
            </>
          )}

        </div>
        <Handle
          type="source"
          position={Position.Right}
          isConnectable={isConnectable}
          className="w-3 h-3 bg-blue-500"
        />
      </div>

      {showTrimModal && (
        <TrimModal
           id={id}
           data={data}
           onClose={() => setShowTrimModal(false)}
        />
      )}
    </>
  );
}
