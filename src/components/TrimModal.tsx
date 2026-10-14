import React, { useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AudioNodeData } from '../types';
import { useAppStore } from '../store';
import { X } from 'lucide-react';
import { audioEngine } from '../audioEngine';

export default function TrimModal({ id, data, onClose }: { id: string, data: AudioNodeData, onClose: () => void }) {
  const updateNodeData = useAppStore(state => state.updateNodeData);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });

  useEffect(() => {
    // Center the window on mount based on an estimated width of 1000px and height of 500px
    setPosition({
      x: Math.max(20, window.innerWidth / 2 - 500),
      y: Math.max(20, window.innerHeight / 2 - 250)
    });
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    setIsDragging(true);
    dragStart.current = { x: e.clientX - position.x, y: e.clientY - position.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    setPosition({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setIsDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  useEffect(() => {
    // Basic waveform drawing
    if (!data.audioUrl) return;
    
    const drawWaveform = async () => {
        const buffer = await audioEngine.loadAudio(data.audioUrl!, id);
        if (!buffer || !canvasRef.current) return;
        
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        // Simple waveform drawing (first channel)
        const rawData = buffer.getChannelData(0);
        const step = Math.ceil(rawData.length / canvas.width);
        const amp = canvas.height / 2;
        
        ctx.fillStyle = '#0f172a'; // slate-950
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.fillStyle = '#3b82f6'; // blue-500
        for (let i = 0; i < canvas.width; i++) {
           let min = 1.0;
           let max = -1.0;
           for (let j = 0; j < step; j++) {
              const datum = rawData[(i * step) + j];
              if (datum < min) min = datum;
              if (datum > max) max = datum;
           }
           const y = (1 + min) * amp;
           const height = Math.max(1, (max - min) * amp);
           ctx.fillRect(i, y, 1, height);
        }
        
        // Draw overlays for trim
        const startX = (data.trimStart / data.duration) * canvas.width;
        const endX = (data.trimEnd / data.duration) * canvas.width;
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, startX, canvas.height);
        ctx.fillRect(endX, 0, canvas.width - endX, canvas.height);
        
        ctx.strokeStyle = '#22c55e'; // green-500
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, 0);
        ctx.lineTo(startX, canvas.height);
        ctx.moveTo(endX, 0);
        ctx.lineTo(endX, canvas.height);
        ctx.stroke();
    };
    
    drawWaveform();
  }, [data.audioUrl, data.trimStart, data.trimEnd, data.duration, id]);

  const modalContent = (
    <div 
      className="fixed z-50 flex flex-col bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden w-[90vw] max-w-5xl"
      style={{ left: position.x, top: position.y }}
    >
      <div 
        className="flex justify-between items-center p-4 border-b border-slate-800 bg-slate-950 cursor-grab active:cursor-grabbing select-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <h2 className="text-lg font-bold text-slate-200 pointer-events-none">Edit Audio: {data.audioName}</h2>
        <button 
          onClick={onClose} 
          onPointerDown={e => e.stopPropagation()} 
          className="text-slate-400 hover:text-white transition-colors cursor-pointer z-10"
        >
          <X size={24} />
        </button>
      </div>

      <div className="p-6 flex flex-col gap-6">
         <div className="relative border border-slate-800 rounded bg-slate-950 overflow-hidden">
           <canvas ref={canvasRef} width={1200} height={200} className="w-full h-[200px]" />
         </div>
         
         <div className="grid grid-cols-2 gap-8">
           <div className="flex flex-col gap-4">
              <h3 className="font-semibold text-slate-300 border-b border-slate-800 pb-2">Trim</h3>
              
              <div className="flex flex-col gap-2">
                 <label className="text-sm text-slate-400">Start Time (seconds)</label>
                 <input
                   type="range"
                   min="0"
                   max={data.duration}
                   step="0.01"
                   value={data.trimStart}
                   onChange={(e) => updateNodeData(id, { trimStart: Math.min(parseFloat(e.target.value), data.trimEnd - 0.1) })}
                   className="accent-blue-500"
                 />
                 <span className="text-xs text-slate-500 text-right">{data.trimStart.toFixed(2)}s</span>
              </div>
              
              <div className="flex flex-col gap-2">
                 <label className="text-sm text-slate-400">End Time (seconds)</label>
                 <input
                   type="range"
                   min="0"
                   max={data.duration}
                   step="0.01"
                   value={data.trimEnd}
                   onChange={(e) => updateNodeData(id, { trimEnd: Math.max(parseFloat(e.target.value), data.trimStart + 0.1) })}
                   className="accent-blue-500"
                 />
                 <span className="text-xs text-slate-500 text-right">{data.trimEnd.toFixed(2)}s</span>
              </div>
           </div>
           
           <div className="flex flex-col gap-4">
              <h3 className="font-semibold text-slate-300 border-b border-slate-800 pb-2">Effects</h3>
              
              <div className="flex flex-col gap-2">
                 <label className="text-sm text-slate-400">Fade In (seconds)</label>
                 <input
                   type="range"
                   min="0"
                   max="5"
                   step="0.1"
                   value={data.fadeIn}
                   onChange={(e) => updateNodeData(id, { fadeIn: parseFloat(e.target.value) })}
                   className="accent-purple-500"
                 />
                 <span className="text-xs text-slate-500 text-right">{data.fadeIn.toFixed(1)}s</span>
              </div>
              
              <div className="flex flex-col gap-2">
                 <label className="text-sm text-slate-400">Fade Out (seconds)</label>
                 <input
                   type="range"
                   min="0"
                   max="5"
                   step="0.1"
                   value={data.fadeOut}
                   onChange={(e) => updateNodeData(id, { fadeOut: parseFloat(e.target.value) })}
                   className="accent-purple-500"
                 />
                 <span className="text-xs text-slate-500 text-right">{data.fadeOut.toFixed(1)}s</span>
              </div>
              
              <label className="flex items-center gap-3 mt-2 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={data.normalize}
                  onChange={(e) => updateNodeData(id, { normalize: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-blue-500 focus:ring-blue-500"
                />
                <span className="text-sm text-slate-400 group-hover:text-slate-300 transition-colors">Normalize (Peak to 0dB)</span>
              </label>
           </div>
         </div>
         
         <div className="flex justify-end pt-4 border-t border-slate-800">
           <button 
             onClick={onClose} 
             className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2 rounded-md text-sm font-medium transition-colors shadow-lg"
           >
             Done
           </button>
         </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
