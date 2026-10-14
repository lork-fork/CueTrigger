import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { useAppStore } from '../../store';
import { TriggerNodeData } from '../../types';
import { audioEngine, useAudioEngineState } from '../../audioEngine';
import { executeSequence } from '../../sequenceRunner';
import { SQUARE_COLORS } from '../../colors';
import { Palette, Play, Square } from 'lucide-react';

export default function TriggerNode({ id, data, isConnectable, selected }: { id: string; data: TriggerNodeData; isConnectable: boolean; selected?: boolean }) {
  const updateNodeData = useAppStore((state) => state.updateNodeData);
  const mode = useAppStore((state) => state.mode);
  const { playingIds, pausedIds } = useAudioEngineState();
  const isActive = playingIds.includes(id) || pausedIds.includes(id);

  // Fire this trigger's whole chain like a GO in Performance mode; press again to stop it
  const handleTestPlay = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isActive) {
      audioEngine.stopTrigger(id);
      return;
    }
    audioEngine.init();
    if (audioEngine.context && audioEngine.context.state === 'suspended') {
      await audioEngine.context.resume().catch(() => {});
    }
    if (data.behavior === 'cut') audioEngine.cutOtherTriggers(id, 0.04);
    executeSequence(id, 0, false);
  };
  const keyConflict = useAppStore((state) => {
    const key = (data.keyTrigger || '').trim().toLowerCase();
    if (!key) return null;
    const other = state.nodes.find(
      (n) => n.id !== id && n.type === 'triggerNode' && ((n.data as TriggerNodeData).keyTrigger || '').trim().toLowerCase() === key
    );
    return other ? ((other.data as TriggerNodeData).title || 'Untitled') : null;
  });

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault();
    updateNodeData(id, { keyTrigger: e.key });
  };

  if (mode === 'performance') return null; // Rendered differently in performance mode

  const tileColor = data.color || '#1e293b';

  return (
    <div 
      className={`bg-slate-800 border-2 rounded-lg shadow-xl text-white min-w-[210px] overflow-hidden transition-all ${
        selected ? 'ring-4 ring-green-400 ring-offset-2 ring-offset-slate-950' : ''
      }`}
      style={{
        borderColor: tileColor === '#1e293b' ? '#22c55e' : tileColor,
      }}
    >
      <div 
        className="custom-drag-handle cursor-grab active:cursor-grabbing p-2 flex justify-between items-center border-b border-slate-700/80 transition-colors"
        style={{
          backgroundColor: tileColor === '#1e293b' ? '#0f172a' : tileColor,
        }}
      >
        <span className="font-bold text-sm text-white drop-shadow pointer-events-none flex items-center gap-1.5">
          Trigger
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleTestPlay}
            className={`nodrag p-1 rounded cursor-pointer transition-colors ${
              isActive ? 'bg-amber-500 text-slate-950 hover:bg-amber-400' : 'bg-black/30 text-green-400 hover:bg-black/50 hover:text-green-300'
            }`}
            title={isActive ? 'Stop this trigger' : 'Test this trigger (plays its whole chain)'}
          >
            {isActive ? <Square size={12} className="fill-current" /> : <Play size={12} className="fill-current" />}
          </button>
          <span
            className="w-3 h-3 rounded-full border border-white/60 shadow-sm"
            style={{ backgroundColor: tileColor }}
            title={`Color: ${tileColor}`}
          />
        </div>
      </div>
      <div className="p-3.5 flex flex-col gap-3 nodrag cursor-default">
        <input
          type="text"
          value={data.title}
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
          className="bg-slate-700 text-white font-bold p-1 rounded border border-slate-600 focus:outline-none focus:border-green-400 text-sm"
          placeholder="Trigger Title"
        />
        
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 uppercase tracking-wider w-16">Key:</label>
          <input
            type="text"
            value={data.keyTrigger?.toUpperCase() || ''}
            onKeyDown={handleKeyDown}
            readOnly
            className="bg-slate-900 text-green-400 text-center font-mono p-1 rounded border border-slate-700 w-16 cursor-pointer"
            placeholder="Press key"
          />
        </div>
        {keyConflict && (
          <div className="text-[11px] font-semibold text-red-300 bg-red-950/60 border border-red-500/50 rounded px-2 py-1">
            Key also used by "{keyConflict}". Only one of them will fire.
          </div>
        )}
        

        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 uppercase tracking-wider w-16">Mode:</label>
          <select
            value={data.behavior}
            onChange={(e) => {
              updateNodeData(id, { behavior: e.target.value as any });
              audioEngine.setTriggerDuck(id, e.target.value === 'duck');
            }}
            className="bg-slate-700 text-white text-xs p-1 rounded border border-slate-600 flex-1"
          >
            <option value="overlay">Overlay</option>
            <option value="duck">Duck Others (incl. Playlist)</option>
            <option value="cut">Cut Previous (Fast Fade)</option>
          </select>
        </div>

        {/* Color Customization */}
        <div className="flex flex-col gap-1.5 pt-2 border-t border-slate-700/80">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="uppercase tracking-wider flex items-center gap-1 font-semibold text-[11px]">
              <Palette size={12} className="text-slate-400" /> Color:
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono text-slate-400">{tileColor}</span>
              <label 
                className="w-5 h-5 rounded-md border border-white/40 cursor-pointer overflow-hidden shadow-sm flex items-center justify-center relative hover:scale-105 transition-transform"
                title="Choose custom color"
              >
                <input
                  type="color"
                  value={tileColor}
                  onChange={(e) => updateNodeData(id, { color: e.target.value })}
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
                onClick={() => updateNodeData(id, { color: c.value })}
                className={`w-4 h-4 rounded-md border transition-transform hover:scale-115 cursor-pointer ${
                  tileColor.toLowerCase() === c.value.toLowerCase() ? 'ring-2 ring-white scale-110 border-white' : 'border-black/40'
                }`}
                style={{ backgroundColor: c.value }}
                title={c.name}
              />
            ))}
          </div>
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={isConnectable}
        className="w-3 h-3 bg-green-500"
      />
    </div>
  );
}
