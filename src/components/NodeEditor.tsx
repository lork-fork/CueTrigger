import { ReactFlow, Background, Controls } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAppStore, setViewCenterProvider, AppNode } from '../store';
import { AudioNodeData } from '../types';
import { audioEngine } from '../audioEngine';
import { saveAudioBlob } from '../storage';
import { v4 as uuidv4 } from 'uuid';
import TriggerNode from './nodes/TriggerNode';
import AudioNode from './nodes/AudioNode';
import CrossFadeNode from './nodes/CrossFadeNode';
import CustomEdge from './edges/CustomEdge';
import { useMemo, useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Plus } from 'lucide-react';
import type { ReactFlowInstance } from '@xyflow/react';

const nodeTypes = {
  triggerNode: TriggerNode,
  audioNode: AudioNode,
  crossFadeNode: CrossFadeNode,
};

const edgeTypes = {
  custom: CustomEdge,
};

export default function NodeEditor() {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, duplicateNodes } = useAppStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.shiftKey && e.key.toLowerCase() === 'd') {
        const selectedNodeIds = nodes.filter(n => n.selected).map(n => n.id);
        if (selectedNodeIds.length > 0) {
          duplicateNodes(selectedNodeIds);
        }
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nodes, duplicateNodes]);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance<any, any> | null>(null);

  // New nodes appear at the center of the visible canvas, wherever it's panned or zoomed
  useEffect(() => {
    setViewCenterProvider(() => {
      const flow = flowRef.current;
      const el = wrapperRef.current;
      if (!flow || !el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    });
    return () => setViewCenterProvider(null);
  }, []);

  // Right-click on empty canvas: a small menu to add a node at that spot
  const [menu, setMenu] = useState<{ left: number; top: number; flowX: number; flowY: number } | null>(null);
  const addNode = useAppStore((s) => s.addNode);

  const handlePaneContextMenu = (e: MouseEvent | ReactMouseEvent) => {
    e.preventDefault();
    const flow = flowRef.current;
    const el = wrapperRef.current;
    if (!flow || !el) return;
    const rect = el.getBoundingClientRect();
    const pos = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    // Keep the menu inside the editor area
    const left = Math.min(e.clientX - rect.left, rect.width - 170);
    const top = Math.min(e.clientY - rect.top, rect.height - 130);
    setMenu({ left: Math.max(0, left), top: Math.max(0, top), flowX: pos.x, flowY: pos.y });
  };

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-node-menu]')) setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [menu]);

  const addFromMenu = (type: 'triggerNode' | 'audioNode' | 'crossFadeNode') => {
    if (menu) addNode(type, { x: menu.flowX, y: menu.flowY });
    setMenu(null);
  };

  // Dropping audio files on the canvas creates one audio node per file, where it was dropped
  const handleDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    const overNode = (e.target as HTMLElement).closest('.react-flow__node');
    e.dataTransfer.dropEffect = overNode ? 'none' : 'copy';
  };

  const handleDrop = async (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    // Dropping onto an existing node does nothing
    if ((e.target as HTMLElement).closest('.react-flow__node')) return;
    const flow = flowRef.current;
    if (!flow) return;

    const files: File[] = Array.from(e.dataTransfer.files);
    const audioFiles = files.filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|oga|m4a|aac|flac|webm|aif|aiff)$/i.test(f.name));
    const { setNotice } = useAppStore.getState();
    if (audioFiles.length < files.length) {
      setNotice(audioFiles.length === 0 ? 'Only audio files can be dropped here.' : 'Skipped files that are not audio.');
      setTimeout(() => useAppStore.getState().setNotice(null), 4000);
    }

    const dropPoint = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    audioEngine.init();
    for (let i = 0; i < audioFiles.length; i++) {
      const file = audioFiles[i];
      const id = uuidv4();
      await saveAudioBlob(id, file);
      const url = URL.createObjectURL(file);
      const buffer = await audioEngine.loadAudio(url, id).catch(() => null);
      const duration = buffer ? buffer.duration : 0;
      const data: AudioNodeData = {
        audioUrl: url,
        audioName: file.name,
        volume: 1,
        pitch: 1,
        loopCount: 0,
        startDelay: 0,
        trimStart: 0,
        trimEnd: duration,
        duration,
        normalize: false,
        fadeIn: 0,
        fadeOut: 0,
      };
      const node: AppNode = {
        id,
        type: 'audioNode',
        // Centered on the drop point; extra files step down-right
        position: { x: dropPoint.x - 125 + i * 30, y: dropPoint.y - 40 + i * 30 },
        data,
      };
      useAppStore.getState().setNodes([...useAppStore.getState().nodes, node]);
    }
  };

  return (
    <div ref={wrapperRef} className="relative w-full h-full bg-slate-950" onDragOver={handleDragOver} onDrop={handleDrop}>
      <ReactFlow
        onInit={(instance) => { flowRef.current = instance; }}
        onPaneContextMenu={handlePaneContextMenu}
        onMoveStart={() => setMenu(null)}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: 'custom' }}
        dragHandle=".custom-drag-handle"
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        className="dark"
      >
        <Background color="#334155" gap={24} />
        <Controls className="bg-slate-800 fill-white text-white border-slate-700" />
      </ReactFlow>

      {menu && (
        <div
          data-node-menu
          className="absolute z-50 w-40 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl py-1 text-sm"
          style={{ left: menu.left, top: menu.top }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider font-bold text-slate-500">Add node</div>
          <button onClick={() => addFromMenu('triggerNode')} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-slate-200 hover:bg-slate-800 cursor-pointer">
            <Plus size={14} className="text-green-400" /> Trigger
          </button>
          <button onClick={() => addFromMenu('audioNode')} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-slate-200 hover:bg-slate-800 cursor-pointer">
            <Plus size={14} className="text-blue-400" /> Audio
          </button>
          <button onClick={() => addFromMenu('crossFadeNode')} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-slate-200 hover:bg-slate-800 cursor-pointer">
            <Plus size={14} className="text-purple-400" /> Crossfade
          </button>
        </div>
      )}
    </div>
  );
}
