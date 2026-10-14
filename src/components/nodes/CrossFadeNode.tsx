import { Handle, Position } from '@xyflow/react';
import { useAppStore } from '../../store';
import { CrossFadeNodeData } from '../../types';
import NumberField from '../NumberField';

export default function CrossFadeNode({ id, data, isConnectable, selected }: { id: string; data: CrossFadeNodeData; isConnectable: boolean; selected?: boolean }) {
  const updateNodeData = useAppStore((state) => state.updateNodeData);
  const mode = useAppStore((state) => state.mode);

  if (mode === 'performance') return null;

  return (
    <div className={`bg-slate-800 border-2 border-purple-500 rounded-lg shadow-xl text-white min-w-[150px] overflow-hidden transition-all ${selected ? 'ring-4 ring-purple-400 ring-offset-2 ring-offset-slate-950' : ''}`}>
       <Handle
        type="target"
        position={Position.Left}
        isConnectable={isConnectable}
        className="w-3 h-3 bg-purple-500"
      />
      <div className="custom-drag-handle cursor-grab active:cursor-grabbing bg-slate-900 p-2 flex justify-center items-center border-b border-slate-700">
        <span className="font-bold text-sm text-purple-400 pointer-events-none">Crossfade</span>
      </div>
      <div className="flex flex-col gap-2 items-center p-3 nodrag cursor-default">
        <div className="flex items-center gap-2 w-full">
           <NumberField
             min={0.1}
             step={0.1}
             fallback={0.1}
             value={data.duration}
             onChange={(v) => updateNodeData(id, { duration: v })}
             className="bg-slate-900 text-center text-xs p-1 rounded border border-slate-700 w-full"
           />
           <span className="text-xs text-slate-400">sec</span>
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={isConnectable}
        className="w-3 h-3 bg-purple-500"
      />
    </div>
  );
}
