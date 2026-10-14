import { create } from 'zustand';
import {
  Connection,
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  addEdge,
  OnNodesChange,
  OnEdgesChange,
  OnConnect,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react';
import { AppNodeData, AudioNodeData, TriggerBehavior, PlaylistTrack, PlaylistSettings, NamedPlaylist, DEFAULT_PLAYLIST_ID, normalizePlaylists } from './types';
import { v4 as uuidv4 } from 'uuid';
import { deleteAudioBlob, getAudioBlob, saveAudioBlob } from './storage';

export type AppNode = Node<AppNodeData>;

// The editor registers this so new nodes land in the middle of what's on screen
let viewCenterProvider: (() => { x: number; y: number } | null) | null = null;
export function setViewCenterProvider(fn: (() => { x: number; y: number } | null) | null) {
  viewCenterProvider = fn;
}

// Rough half-sizes so a new node is centered rather than hanging off the center point
const NODE_HALF_SIZE: Record<string, { x: number; y: number }> = {
  triggerNode: { x: 110, y: 150 },
  audioNode: { x: 125, y: 70 },
  crossFadeNode: { x: 80, y: 40 },
};

interface AppState {
  nodes: AppNode[];
  edges: Edge[];
  globalVolume: number;
  mode: 'editor' | 'performance';
  onNodesChange: OnNodesChange<AppNode>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  setNodes: (nodes: AppNode[]) => void;
  setEdges: (edges: Edge[]) => void;
  addNode: (type: 'triggerNode' | 'audioNode' | 'crossFadeNode', at?: { x: number; y: number }) => void;
  updateNodeData: (id: string, data: Partial<AppNodeData>) => void;
  setGlobalVolume: (vol: number) => void;
  setMode: (mode: 'editor' | 'performance') => void;
  removeEdge: (edgeId: string) => void;
  duplicateNodes: (ids: string[]) => void;
  loadState: (nodes: AppNode[], edges: Edge[], globalVolume: number, playlists?: NamedPlaylist[], playlistSettings?: PlaylistSettings, viewedPlaylistId?: string) => void;
  moveTriggerNode: (nodeId: string, toIndex: number) => void;
  normalizeTriggerIndices: () => void;
  activeTriggers: string[];
  addActiveTrigger: (id: string) => void;
  removeActiveTrigger: (id: string) => void;
  clearActiveTriggers: () => void;
  isPaused: boolean;
  isFadingPause: boolean;
  notice: string | null;
  setNotice: (notice: string | null) => void;
  setIsPaused: (isPaused: boolean) => void;
  setIsFadingPause: (isFadingPause: boolean) => void;
  // Playlists. New tracks go into the playlist being viewed in the drawer.
  playlists: NamedPlaylist[];
  viewedPlaylistId: string;
  playlistSettings: PlaylistSettings;
  isPlaylistDrawerOpen: boolean;
  setIsPlaylistDrawerOpen: (open: boolean) => void;
  setViewedPlaylistId: (id: string) => void;
  createPlaylist: (name?: string) => string;
  addPlaylist: (playlist: NamedPlaylist) => void;
  renamePlaylist: (id: string, name: string) => void;
  deletePlaylist: (id: string) => void;
  addPlaylistTrack: (track: PlaylistTrack) => void;
  updatePlaylistTrack: (id: string, updates: Partial<PlaylistTrack>) => void;
  removePlaylistTrack: (id: string) => void;
  reorderPlaylistTracks: (fromIndex: number, toIndex: number) => void;
  setPlaylistSettings: (settings: Partial<PlaylistSettings>) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  nodes: [],
  edges: [],
  globalVolume: 1,
  mode: 'editor',
  activeTriggers: [],
  isPaused: false,
  isFadingPause: false,
  notice: null,
  setNotice: (notice: string | null) => set({ notice }),
  setIsPaused: (isPaused: boolean) => set({ isPaused }),
  setIsFadingPause: (isFadingPause: boolean) => set({ isFadingPause }),
  addActiveTrigger: (id: string) => set({ activeTriggers: [...get().activeTriggers, id] }),
  removeActiveTrigger: (id: string) => set({ activeTriggers: get().activeTriggers.filter(t => t !== id) }),
  clearActiveTriggers: () => set({ activeTriggers: [] }),
  // Playlist initial state
  playlists: normalizePlaylists(),
  viewedPlaylistId: DEFAULT_PLAYLIST_ID,
  playlistSettings: {
    crossfadeDuration: 2.0,
    shuffle: false,
    loop: false,
    volume: 1.0,
  },
  isPlaylistDrawerOpen: false,
  setIsPlaylistDrawerOpen: (open: boolean) => set({ isPlaylistDrawerOpen: open }),
  setViewedPlaylistId: (id: string) => {
    if (get().playlists.some(p => p.id === id)) set({ viewedPlaylistId: id });
  },
  createPlaylist: (name?: string) => {
    const id = uuidv4();
    const existing = get().playlists;
    let n = existing.length + 1;
    while (existing.some(p => p.name === `Playlist ${n}`)) n++;
    set({
      playlists: [...existing, { id, name: name?.trim() || `Playlist ${n}`, tracks: [] }],
      viewedPlaylistId: id,
    });
    return id;
  },
  addPlaylist: (playlist: NamedPlaylist) => set({
    playlists: [...get().playlists, playlist],
    viewedPlaylistId: playlist.id,
  }),
  renamePlaylist: (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set({ playlists: get().playlists.map(p => (p.id === id ? { ...p, name: trimmed } : p)) });
  },
  deletePlaylist: (id: string) => {
    const { playlists, viewedPlaylistId } = get();
    if (playlists.length <= 1) return;
    const target = playlists.find(p => p.id === id);
    if (!target) return;
    target.tracks.forEach(t => deleteAudioBlob(`track-${t.id}`));
    const remaining = playlists.filter(p => p.id !== id);
    set({
      playlists: remaining,
      viewedPlaylistId: viewedPlaylistId === id ? remaining[0].id : viewedPlaylistId,
    });
  },
  addPlaylistTrack: (track: PlaylistTrack) => {
    const { playlists, viewedPlaylistId } = get();
    set({ playlists: playlists.map(p => (p.id === viewedPlaylistId ? { ...p, tracks: [...p.tracks, track] } : p)) });
  },
  updatePlaylistTrack: (id: string, updates: Partial<PlaylistTrack>) => set({
    playlists: get().playlists.map(p =>
      p.tracks.some(t => t.id === id)
        ? { ...p, tracks: p.tracks.map(t => (t.id === id ? { ...t, ...updates } : t)) }
        : p
    ),
  }),
  removePlaylistTrack: (id: string) => {
    deleteAudioBlob(`track-${id}`);
    set({ playlists: get().playlists.map(p => ({ ...p, tracks: p.tracks.filter(t => t.id !== id) })) });
  },
  reorderPlaylistTracks: (fromIndex: number, toIndex: number) => {
    const { playlists, viewedPlaylistId } = get();
    set({
      playlists: playlists.map(p => {
        if (p.id !== viewedPlaylistId) return p;
        const list = [...p.tracks];
        if (fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length) return p;
        const [moved] = list.splice(fromIndex, 1);
        list.splice(toIndex, 0, moved);
        return { ...p, tracks: list };
      }),
    });
  },
  setPlaylistSettings: (settings: Partial<PlaylistSettings>) => set({
    playlistSettings: { ...get().playlistSettings, ...settings }
  }),
  onNodesChange: (changes: NodeChange<AppNode>[]) => {
    changes.forEach((c) => {
      if (c.type === 'remove') {
        deleteAudioBlob(c.id);
      }
    });
    set({
      nodes: applyNodeChanges(changes, get().nodes),
    });
  },
  onEdgesChange: (changes: EdgeChange[]) => {
    set({
      edges: applyEdgeChanges(changes, get().edges),
    });
  },
  onConnect: (connection: Connection) => {
    set({
      edges: addEdge(connection, get().edges),
    });
  },
  setNodes: (nodes: AppNode[]) => set({ nodes }),
  setEdges: (edges: Edge[]) => set({ edges }),
  addNode: (type: 'triggerNode' | 'audioNode' | 'crossFadeNode', at?: { x: number; y: number }) => {
    const id = uuidv4();
    // Centered on the given point (e.g. a right-click), otherwise on the middle of the view
    const center = at ?? viewCenterProvider?.();
    let position = { x: Math.random() * 200 + 100, y: Math.random() * 200 + 100 };
    if (center) {
      const half = NODE_HALF_SIZE[type] ?? { x: 0, y: 0 };
      position = { x: center.x - half.x, y: center.y - half.y };
      // Step down-right while another node already sits on this spot, so they don't stack exactly
      const taken = (p: { x: number; y: number }) =>
        get().nodes.some(n => Math.abs(n.position.x - p.x) < 20 && Math.abs(n.position.y - p.y) < 20);
      for (let i = 0; i < 20 && taken(position); i++) {
        position = { x: position.x + 30, y: position.y + 30 };
      }
    }
    const newNode: AppNode = {
      id,
      type,
      position,
      data: getDefaultData(type),
    };
    set({ nodes: [...get().nodes, newNode] });
  },
  updateNodeData: (id: string, data: Partial<AppNodeData>) => {
    set({
      nodes: get().nodes.map((node) => {
        if (node.id === id) {
          return { ...node, data: { ...node.data, ...data } };
        }
        return node;
      }),
    });
  },
  setGlobalVolume: (vol: number) => set({ globalVolume: vol }),
  setMode: (mode: 'editor' | 'performance') => set({ mode }),
  removeEdge: (edgeId: string) => set({ edges: get().edges.filter((e) => e.id !== edgeId) }),
  duplicateNodes: async (ids: string[]) => {
    const { nodes } = get();
    const nodesToDuplicate = nodes.filter((n) => ids.includes(n.id));
    const newNodes = await Promise.all(
      nodesToDuplicate.map(async (n) => {
        const newId = uuidv4();
        const newData = { ...n.data };
        // The copy gets its own grid spot in Performance mode instead of sharing the original's
        delete newData.performanceIndex;
        if (n.type === 'audioNode') {
          const blob = await getAudioBlob(n.id);
          if (blob) {
            await saveAudioBlob(newId, blob);
            (newData as AudioNodeData).audioUrl = URL.createObjectURL(blob);
          }
        }
        return {
          ...n,
          id: newId,
          position: { x: n.position.x + 50, y: n.position.y + 50 },
          selected: false,
          data: newData,
        };
      })
    );

    set({ nodes: [...get().nodes, ...newNodes] });
    get().normalizeTriggerIndices();
  },
  loadState: (nodes: AppNode[], edges: Edge[], globalVolume: number, playlists?: NamedPlaylist[], playlistSettings?: PlaylistSettings, viewedPlaylistId?: string) => {
    const nextPlaylists = playlists ? normalizePlaylists(playlists) : get().playlists;
    const viewed = viewedPlaylistId && nextPlaylists.some(p => p.id === viewedPlaylistId)
      ? viewedPlaylistId
      : nextPlaylists[0].id;
    set({
      nodes,
      edges,
      globalVolume,
      playlists: nextPlaylists,
      viewedPlaylistId: viewed,
      ...(playlistSettings ? { playlistSettings } : {}),
    });
    // Older shows can have stacked tiles from duplicated triggers
    get().normalizeTriggerIndices();
  },
  moveTriggerNode: (nodeId: string, toIndex: number) => {
    set((state) => {
      const triggers = state.nodes.filter(n => n.type === 'triggerNode');
      const indexMap = new Map<number, string>();

      triggers.forEach(t => {
        if (t.data.performanceIndex !== undefined && t.id !== nodeId) {
          indexMap.set(t.data.performanceIndex as number, t.id);
        }
      });

      let currentIndex = toIndex;
      const nodesToShift: {id: string, newIndex: number}[] = [];

      while (indexMap.has(currentIndex)) {
        nodesToShift.push({ id: indexMap.get(currentIndex)!, newIndex: currentIndex + 1 });
        currentIndex++;
      }

      const updatedNodes = state.nodes.map(n => {
        if (n.id === nodeId) {
          return { ...n, data: { ...n.data, performanceIndex: toIndex } };
        }
        const shift = nodesToShift.find(s => s.id === n.id);
        if (shift) {
          return { ...n, data: { ...n.data, performanceIndex: shift.newIndex } };
        }
        return n;
      });

      return { nodes: updatedNodes };
    });
  },
  // Give every trigger its own grid spot. Triggers without one, or sharing one with an earlier
  // trigger (e.g. an older duplicate), move to the lowest free spot; everything else stays put.
  normalizeTriggerIndices: () => {
    set((state) => {
      const triggers = state.nodes.filter(n => n.type === 'triggerNode');
      const taken = new Set<number>();
      const needsSpot = new Set<string>();

      triggers.forEach(t => {
        const idx = t.data.performanceIndex as number | undefined;
        if (idx === undefined || !Number.isInteger(idx) || idx < 0 || taken.has(idx)) {
          needsSpot.add(t.id);
        } else {
          taken.add(idx);
        }
      });

      if (needsSpot.size === 0) return state;

      let nextAvailable = 0;
      const updatedNodes = state.nodes.map(n => {
        if (!needsSpot.has(n.id)) return n;
        while (taken.has(nextAvailable)) nextAvailable++;
        taken.add(nextAvailable);
        return { ...n, data: { ...n.data, performanceIndex: nextAvailable } };
      });

      return { nodes: updatedNodes };
    });
  }
}));

export function getViewedTracks(state: { playlists: NamedPlaylist[]; viewedPlaylistId: string }): PlaylistTrack[] {
  return state.playlists.find(p => p.id === state.viewedPlaylistId)?.tracks ?? [];
}

function getDefaultData(type: string): AppNodeData {
  switch (type) {
    case 'triggerNode':
      return {
        title: 'New Trigger',
        keyTrigger: '',
        behavior: 'overlay',
        volumeBoost: 1.0,
        color: '#1e293b',
      };
    case 'audioNode':
      return {
        audioUrl: null,
        audioName: null,
        volume: 1,
        pitch: 1,
        loopCount: 0,
        startDelay: 0,
        trimStart: 0,
        trimEnd: 0,
        duration: 0,
        normalize: false,
        fadeIn: 0,
        fadeOut: 0,
      } as AudioNodeData;
    case 'crossFadeNode':
      return {
        duration: 2,
      };
    default:
      return {} as AppNodeData;
  }
}
