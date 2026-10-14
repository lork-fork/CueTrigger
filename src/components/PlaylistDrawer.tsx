import React, { useRef, useState } from 'react';
import { useAppStore, getViewedTracks } from '../store';
import { playlistEngine, usePlaylistEngineState } from '../playlistEngine';
import { audioEngine } from '../audioEngine';
import { PlaylistTrack } from '../types';
import { saveAudioBlob, getAudioBlob } from '../storage';
import { exportPlaylist, importPlaylist } from '../sessionManager';
import { v4 as uuidv4 } from 'uuid';
import PlaylistTrackSettingsModal from './PlaylistTrackSettingsModal';
import {
  ListMusic,
  ChevronRight,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Plus,
  Sliders,
  GripVertical,
  Trash2,
  Upload,
  Volume2,
  FolderPlus,
  Pencil,
  Check,
  X,
  FileDown,
  FileUp,
} from 'lucide-react';

const NEW_PLAYLIST_OPTION = '__new_playlist__';

function formatTime(sec: number): string {
  if (isNaN(sec) || sec < 0) return '0:00';
  const mins = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${mins}:${s < 10 ? '0' : ''}${s}`;
}

export default function PlaylistDrawer() {
  const {
    playlists,
    viewedPlaylistId,
    setViewedPlaylistId,
    createPlaylist,
    addPlaylist,
    renamePlaylist,
    deletePlaylist,
    setNotice,
    playlistSettings,
    isPlaylistDrawerOpen,
    setIsPlaylistDrawerOpen,
    addPlaylistTrack,
    removePlaylistTrack,
    reorderPlaylistTracks,
    setPlaylistSettings,
    mode,
    nodes,
  } = useAppStore();

  const { currentTrackIndex, isPlaying, isPaused, currentTime, duration, playingPlaylistId } = usePlaylistEngineState();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [selectedTrackForEdit, setSelectedTrackForEdit] = useState<PlaylistTrack | null>(null);
  const [showNodePicker, setShowNodePicker] = useState(false);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isTransferring, setIsTransferring] = useState(false);

  // Drag-to-reorder: `drop` is the gap the track will land in (0 = above the first track)
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; drop: number } | null>(null);
  const dragRef = useRef<{ from: number; drop: number; y: number } | null>(null);
  const dragFrameRef = useRef<number | null>(null);

  // The drawer shows and edits the viewed playlist; the transport follows the playing one
  const viewedPlaylist = playlists.find(p => p.id === viewedPlaylistId) ?? playlists[0];
  const playlist = viewedPlaylist?.tracks ?? [];
  const playingPlaylist = playlists.find(p => p.id === playingPlaylistId) ?? null;
  const playingTracks = playingPlaylist?.tracks ?? [];
  const transportTracks = playingPlaylist ? playingTracks : playlist;
  const isViewingPlaying = Boolean(playingPlaylist) && playingPlaylist!.id === viewedPlaylist?.id;
  const isOtherPlaylistActive = Boolean(playingPlaylist) && !isViewingPlaying && (isPlaying || isPaused);

  const currentTrack = currentTrackIndex >= 0 && currentTrackIndex < playingTracks.length
    ? playingTracks[currentTrackIndex]
    : null;

  const handleSelectPlaylist = (value: string) => {
    setConfirmDeleteId(null);
    if (value === NEW_PLAYLIST_OPTION) {
      const id = createPlaylist();
      const created = useAppStore.getState().playlists.find(p => p.id === id);
      setRenameDraft(created?.name ?? '');
      return;
    }
    setRenameDraft(null);
    setViewedPlaylistId(value);
  };

  const commitRename = () => {
    if (renameDraft !== null && viewedPlaylist) renamePlaylist(viewedPlaylist.id, renameDraft);
    setRenameDraft(null);
  };

  const handleDeletePlaylist = () => {
    if (!viewedPlaylist || playlists.length <= 1) return;
    if (confirmDeleteId !== viewedPlaylist.id) {
      setConfirmDeleteId(viewedPlaylist.id);
      setTimeout(() => setConfirmDeleteId(null), 3000);
      return;
    }
    playlistEngine.forgetPlaylist(viewedPlaylist.id);
    deletePlaylist(viewedPlaylist.id);
    setConfirmDeleteId(null);
  };

  const handleExport = async () => {
    if (!viewedPlaylist || isTransferring) return;
    setIsTransferring(true);
    try {
      await exportPlaylist(viewedPlaylist);
    } catch (err) {
      console.error('Failed to export playlist:', err);
      setNotice('Could not export the playlist.');
      setTimeout(() => setNotice(null), 5000);
    } finally {
      setIsTransferring(false);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    setIsTransferring(true);
    try {
      const imported = await importPlaylist(file);
      const names = new Set(useAppStore.getState().playlists.map(p => p.name));
      let name = imported.name;
      for (let n = 2; names.has(name); n++) name = `${imported.name} (${n})`;
      addPlaylist({ ...imported, name });
      audioEngine.preloadAudio(imported.tracks.map(t => ({ url: t.audioUrl, id: `track-${t.id}` })));
    } catch (err) {
      console.error('Failed to import playlist:', err);
      setNotice('Could not import that file. Choose a playlist .zip exported from this app.');
      setTimeout(() => setNotice(null), 5000);
    } finally {
      setIsTransferring(false);
    }
  };

  const findDropGap = (clientY: number) => {
    const rows = listRef.current?.querySelectorAll('[data-track-row]');
    if (!rows) return 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return rows.length;
  };

  const updateDrop = () => {
    const d = dragRef.current;
    if (!d) return;
    const drop = findDropGap(d.y);
    if (drop !== d.drop) {
      d.drop = drop;
      setDrag({ from: d.from, drop });
    }
  };

  const startTrackDrag = (e: React.PointerEvent, index: number) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    dragRef.current = { from: index, drop: index, y: e.clientY };
    setDrag({ from: index, drop: index });
    // Auto-scroll while the pointer is near the top or bottom of the list
    const tick = () => {
      const d = dragRef.current;
      const list = listRef.current;
      if (!d || !list) return;
      const rect = list.getBoundingClientRect();
      const edge = 40;
      if (d.y < rect.top + edge) list.scrollTop -= Math.ceil((rect.top + edge - d.y) / 4);
      else if (d.y > rect.bottom - edge) list.scrollTop += Math.ceil((d.y - (rect.bottom - edge)) / 4);
      updateDrop();
      dragFrameRef.current = requestAnimationFrame(tick);
    };
    dragFrameRef.current = requestAnimationFrame(tick);
  };

  const moveTrackDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current.y = e.clientY;
    updateDrop();
  };

  const endTrackDrag = (commit: boolean) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = null;
    if (!d || !commit) return;
    const to = d.drop > d.from ? d.drop - 1 : d.drop;
    if (to === d.from) return;
    // Keep the playing track playing and marked at its new position
    const playingTrackId = isViewingPlaying && currentTrackIndex >= 0 ? playlist[currentTrackIndex]?.id : null;
    reorderPlaylistTracks(d.from, to);
    if (playingTrackId) {
      playlistEngine.setCurrentTrackIndex(getViewedTracks(useAppStore.getState()).findIndex(t => t.id === playingTrackId));
    }
  };

  // Expanded drawer's main button: plays the viewed playlist when another one is loaded
  const handleMainPlay = () => {
    if (!viewedPlaylist) return;
    if (!isViewingPlaying) {
      playlistEngine.startPlaylist(viewedPlaylist.id);
    } else {
      playlistEngine.togglePlay();
    }
  };

  const totalPlaylistDuration = playlist.reduce((sum, t) => {
    let dur = (t.trimEnd || 0) - (t.trimStart || 0);
    if (dur <= 0) dur = t.duration || 0;
    return sum + Math.max(0, dur);
  }, 0);

  // File Upload Handler
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    audioEngine.init();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const trackId = uuidv4();
      await saveAudioBlob(`track-${trackId}`, file);
      const url = URL.createObjectURL(file);

      let bufferDur = 0;
      if (audioEngine.context) {
        try {
          const ab = await file.arrayBuffer();
          const audioBuffer = await audioEngine.context.decodeAudioData(ab);
          bufferDur = audioBuffer.duration;
          audioEngine.audioBuffers.set(url, audioBuffer);
          audioEngine.audioBuffers.set(`track-${trackId}`, audioBuffer);
        } catch (err) {
          console.error('Error decoding audio for playlist track:', err);
        }
      }

      const newTrack: PlaylistTrack = {
        id: trackId,
        name: file.name.replace(/\.[^/.]+$/, ''),
        audioUrl: url,
        duration: bufferDur,
        trimStart: 0,
        trimEnd: bufferDur,
        volume: 1.0,
      };

      addPlaylistTrack(newTrack);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Add existing AudioNode from project
  const handleAddFromNode = async (nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node || node.type !== 'audioNode') return;
    const data = node.data as any;
    if (!data.audioUrl) return;

    const trackId = uuidv4();

    // Persist audio blob under track-${trackId} so it survives refreshes & sessions
    let nodeBlob = await getAudioBlob(nodeId);
    if (!nodeBlob && data.audioUrl) {
      try {
        const resp = await fetch(data.audioUrl);
        if (resp.ok) {
          nodeBlob = await resp.blob();
        }
      } catch (e) {}
    }
    if (nodeBlob) {
      await saveAudioBlob(`track-${trackId}`, nodeBlob);
    }

    // Also copy cached audioBuffer if present
    const existingBuffer = audioEngine.audioBuffers.get(data.audioUrl) || audioEngine.audioBuffers.get(nodeId);
    if (existingBuffer) {
      audioEngine.audioBuffers.set(`track-${trackId}`, existingBuffer);
      audioEngine.audioBuffers.set(data.audioUrl, existingBuffer);
    }

    const duration = data.duration || (existingBuffer ? existingBuffer.duration : 0);

    const newTrack: PlaylistTrack = {
      id: trackId,
      name: data.audioName || 'Imported Audio',
      audioUrl: data.audioUrl,
      duration: duration,
      trimStart: data.trimStart || 0,
      trimEnd: data.trimEnd || duration || 0,
      volume: data.volume ?? 1.0,
    };

    addPlaylistTrack(newTrack);
    setShowNodePicker(false);
  };

  const audioNodesWithFiles = nodes.filter(
    n => n.type === 'audioNode' && Boolean((n.data as any).audioUrl)
  );

  return (
    <>
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileUpload}
        accept="audio/*"
        multiple
        className="hidden"
      />
      <input
        type="file"
        ref={importInputRef}
        onChange={handleImport}
        accept=".zip,application/zip"
        className="hidden"
      />

      {/* TRACK SETTINGS POPUP */}
      {selectedTrackForEdit && (
        <PlaylistTrackSettingsModal
          track={selectedTrackForEdit}
          onClose={() => setSelectedTrackForEdit(null)}
        />
      )}

      {/* ========================================================================= */}
      {/* 1. COLLAPSED MINI-PLAYER (Always visible on bottom-right when drawer closed) */}
      {/* ========================================================================= */}
      {!isPlaylistDrawerOpen && (
        <div className="fixed bottom-4 right-4 z-40 flex items-center gap-3 bg-slate-900/95 backdrop-blur-xl border border-slate-700/80 rounded-2xl p-2.5 sm:px-4 sm:py-3 shadow-2xl transition-all duration-200 hover:border-slate-600 max-w-[92vw] sm:max-w-[480px]">
          {/* Expand Drawer Button */}
          <button
            onClick={() => setIsPlaylistDrawerOpen(true)}
            className="p-2 rounded-xl bg-blue-600/20 text-blue-400 hover:bg-blue-600 hover:text-white border border-blue-500/30 transition-all flex items-center gap-1.5 cursor-pointer shrink-0"
            title="Open Playlist Drawer"
          >
            <ListMusic size={18} />
            <span className="text-xs font-bold hidden sm:inline">
              {playingPlaylist && (isPlaying || isPaused) ? playingPlaylist.name : 'Playlist'} {transportTracks.length > 0 ? `(${transportTracks.length})` : ''}
            </span>
          </button>

          {/* Track Name & Time */}
          <div className="flex flex-col min-w-0 max-w-[130px] sm:max-w-[170px] shrink-1">
            <span className="text-xs font-bold text-white truncate leading-tight">
              {currentTrack ? currentTrack.name : 'No track playing'}
            </span>
            <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
              <span className="text-blue-400">{formatTime(currentTime)}</span>
              <span>/</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          {/* Player Main Controls: Shuffle, Prev, Play/Pause, Next, Loop */}
          <div className="flex items-center gap-1 shrink-0">
            {/* Shuffle */}
            <button
              onClick={() => setPlaylistSettings({ shuffle: !playlistSettings.shuffle })}
              className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                playlistSettings.shuffle
                  ? 'bg-blue-600/30 text-blue-400 border border-blue-500/40'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
              title={playlistSettings.shuffle ? 'Shuffle: ON' : 'Shuffle: OFF'}
            >
              <Shuffle size={14} />
            </button>

            {/* Previous */}
            <button
              onClick={() => playlistEngine.previous()}
              disabled={transportTracks.length === 0}
              className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              title="Previous Track"
            >
              <SkipBack size={15} />
            </button>

            {/* Play / Pause */}
            <button
              onClick={() => playlistEngine.togglePlay()}
              disabled={transportTracks.length === 0}
              className={`p-2 rounded-full border shadow-md transition-all active:scale-95 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                isPlaying
                  ? 'bg-amber-500 text-slate-950 border-amber-400 hover:bg-amber-400'
                  : 'bg-green-600 text-white border-green-500 hover:bg-green-500'
              }`}
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause size={15} /> : <Play size={15} className="fill-current ml-0.5" />}
            </button>

            {/* Next */}
            <button
              onClick={() => playlistEngine.next()}
              disabled={transportTracks.length === 0}
              className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              title="Next Track"
            >
              <SkipForward size={15} />
            </button>

            {/* Loop */}
            <button
              onClick={() => setPlaylistSettings({ loop: !playlistSettings.loop })}
              className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                playlistSettings.loop
                  ? 'bg-purple-600/30 text-purple-400 border border-purple-500/40'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
              title={playlistSettings.loop ? 'Loop: ON' : 'Loop: OFF'}
            >
              <Repeat size={14} />
            </button>
          </div>

          {/* Seekbar Mini Slider */}
          <div className="hidden md:flex flex-col w-20 shrink-0">
            <input
              type="range"
              min="0"
              max={duration || 1}
              step="0.1"
              value={Math.min(duration || 1, currentTime)}
              onChange={(e) => playlistEngine.seek(parseFloat(e.target.value))}
              disabled={!currentTrack}
              className="w-full accent-blue-500 cursor-pointer h-1.5 bg-slate-800 rounded-lg disabled:opacity-40"
            />
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 2. EXPANDED FULL PLAYLIST DRAWER (Docked on right side of screen)         */}
      {/* ========================================================================= */}
      {isPlaylistDrawerOpen && (
        <aside className="fixed right-0 top-14 bottom-0 z-40 w-80 sm:w-96 bg-slate-900/98 backdrop-blur-2xl border-l border-slate-800 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
          {/* Drawer Header */}
          <div className="p-4 border-b border-slate-800 flex items-center justify-between shrink-0 bg-slate-950/40">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-blue-600/20 text-blue-400 border border-blue-500/30">
                <ListMusic size={18} />
              </div>
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  Playlist
                  <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                    {playlist.length}
                  </span>
                </h2>
                <p className="text-[11px] text-slate-400 font-mono">
                  Total: {formatTime(totalPlaylistDuration)}
                </p>
              </div>
            </div>

            <button
              onClick={() => setIsPlaylistDrawerOpen(false)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
              title="Collapse Drawer"
            >
              <ChevronRight size={20} />
            </button>
          </div>

          {/* Playlist Switcher */}
          <div className="px-3 pt-3 pb-2.5 border-b border-slate-800/80 bg-slate-950/30 flex flex-col gap-2 shrink-0">
            <div className="flex items-center gap-1.5">
              {renameDraft !== null ? (
                <>
                  <input
                    type="text"
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setRenameDraft(null);
                    }}
                    onBlur={commitRename}
                    className="flex-1 min-w-0 bg-slate-950 text-white text-sm font-semibold px-2.5 py-1.5 rounded-lg border border-blue-500 focus:outline-none"
                    placeholder="Playlist name"
                  />
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={commitRename}
                    className="p-1.5 rounded-lg text-green-400 hover:bg-slate-800 cursor-pointer"
                    title="Save name"
                  >
                    <Check size={15} />
                  </button>
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setRenameDraft(null)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
                    title="Cancel"
                  >
                    <X size={15} />
                  </button>
                </>
              ) : (
                <>
                  <select
                    value={viewedPlaylist?.id ?? ''}
                    onChange={(e) => handleSelectPlaylist(e.target.value)}
                    className="flex-1 min-w-0 bg-slate-950 text-white text-sm font-semibold px-2.5 py-1.5 rounded-lg border border-slate-700 hover:border-slate-600 focus:outline-none focus:border-blue-500 cursor-pointer"
                    title="Switch playlist"
                  >
                    {playlists.map(p => {
                      const isActive = p.id === playingPlaylistId && (isPlaying || isPaused);
                      const marker = isActive ? (isPlaying ? '▶ ' : '❚❚ ') : '';
                      return (
                        <option key={p.id} value={p.id}>
                          {marker}{p.name} ({p.tracks.length})
                        </option>
                      );
                    })}
                    {mode === 'editor' && <option value={NEW_PLAYLIST_OPTION}>+ New playlist</option>}
                  </select>
                  {mode === 'editor' && (
                    <>
                      <button
                        onClick={() => setRenameDraft(viewedPlaylist?.name ?? '')}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
                        title="Rename playlist"
                      >
                        <Pencil size={14} />
                      </button>
                      {playlists.length > 1 && (
                        <button
                          onClick={handleDeletePlaylist}
                          className={`p-1.5 rounded-lg cursor-pointer transition-colors ${
                            confirmDeleteId === viewedPlaylist?.id
                              ? 'bg-red-600 text-white'
                              : 'text-slate-500 hover:text-red-400 hover:bg-slate-800'
                          }`}
                          title={confirmDeleteId === viewedPlaylist?.id ? 'Click again to delete this playlist' : 'Delete playlist'}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
            </div>

            {isOtherPlaylistActive && playingPlaylist && (
              <p className="text-[11px] text-amber-300/90">
                {isPlaying ? 'Now playing' : 'Paused'}: <span className="font-semibold">{playingPlaylist.name}</span>. Press play here to switch to this playlist.
              </p>
            )}

            {mode === 'editor' && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => importInputRef.current?.click()}
                  disabled={isTransferring}
                  className="flex-1 py-1.5 px-2 rounded-lg text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                  title="Import a playlist .zip as a new playlist"
                >
                  <FileUp size={13} /> Import Playlist
                </button>
                <button
                  onClick={handleExport}
                  disabled={isTransferring || playlist.length === 0}
                  className="flex-1 py-1.5 px-2 rounded-lg text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Save this playlist and its audio as a .zip"
                >
                  <FileDown size={13} /> {isTransferring ? 'Working…' : 'Export Playlist'}
                </button>
              </div>
            )}
          </div>

          {/* Top Config: Crossfade Slider + Add Track (in Editor Mode) */}
          <div className="p-3 border-b border-slate-800/80 bg-slate-950/20 flex flex-col gap-2.5 shrink-0">
            {/* Playlist Volume (affects only the playlist, not cues) */}
            <div className="flex flex-col gap-1 p-2 rounded-xl bg-slate-950/60 border border-slate-800/80">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                  <Volume2 size={13} className="text-blue-400" />
                  Playlist Volume
                </span>
                <span className={`font-mono font-bold ${(playlistSettings.volume ?? 1) > 1 ? 'text-amber-400' : 'text-blue-400'}`}>
                  {Math.round((playlistSettings.volume ?? 1) * 100)}%
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="1.5"
                step="0.05"
                value={playlistSettings.volume ?? 1}
                onChange={(e) => setPlaylistSettings({ volume: parseFloat(e.target.value) })}
                onDoubleClick={() => setPlaylistSettings({ volume: 1 })}
                className="w-full accent-blue-500 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
                title="Double-click to reset to 100%"
              />
            </div>

            {/* Crossfade Setting */}
            <div className="flex flex-col gap-1 p-2 rounded-xl bg-slate-950/60 border border-slate-800/80">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                  <Sliders size={13} className="text-blue-400" />
                  Crossfade Transitions
                </span>
                <span className="font-mono text-blue-400 font-bold">
                  {playlistSettings.crossfadeDuration.toFixed(1)}s
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="12"
                step="0.5"
                value={playlistSettings.crossfadeDuration}
                onChange={(e) => setPlaylistSettings({ crossfadeDuration: parseFloat(e.target.value) })}
                className="w-full accent-blue-500 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
              />
              <div className="flex justify-between items-center text-[10px] text-slate-500 font-mono">
                <span>0s (Gapless)</span>
                <span>4s</span>
                <span>8s</span>
                <span>12s</span>
              </div>
            </div>

            {/* In Editor Mode: Add Track Options */}
            {mode === 'editor' && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex-1 py-2 px-3 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center gap-1.5 transition-all shadow-md cursor-pointer"
                >
                  <Upload size={14} /> Add Audio File
                </button>

                {audioNodesWithFiles.length > 0 && (
                  <div className="relative">
                    <button
                      onClick={() => setShowNodePicker(!showNodePicker)}
                      className="py-2 px-3 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-1.5 transition-all cursor-pointer"
                      title="Import audio from project nodes"
                    >
                      <FolderPlus size={14} /> From Nodes
                    </button>

                    {showNodePicker && (
                      <div className="absolute right-0 top-full mt-1 w-56 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-2 z-50 flex flex-col gap-1 max-h-56 overflow-y-auto">
                        <span className="text-[10px] uppercase font-bold text-slate-400 px-2 py-1">
                          Select Node Audio:
                        </span>
                        {audioNodesWithFiles.map(n => {
                          const data = n.data as any;
                          return (
                            <button
                              key={n.id}
                              onClick={() => handleAddFromNode(n.id)}
                              className="text-left text-xs px-2.5 py-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors truncate"
                            >
                              {data.audioName || 'Audio Node'}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Track List */}
          <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-1.5">
            {playlist.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-500 text-center p-6 gap-2">
                <ListMusic size={36} className="text-slate-600 mb-1" />
                <p className="text-sm font-semibold text-slate-400">Playlist is empty</p>
                <p className="text-xs text-slate-500">
                  {mode === 'editor'
                    ? 'Upload audio tracks above to build your playlist.'
                    : 'Switch to Editor Mode to add and configure tracks.'}
                </p>
              </div>
            ) : (
              playlist.map((track, index) => {
                const isCurrent = isViewingPlaying && currentTrackIndex === index;
                const isCurrentPlaying = isCurrent && isPlaying;
                let trackDuration = (track.trimEnd || 0) - (track.trimStart || 0);
                if (trackDuration <= 0) trackDuration = track.duration || 0;

                const showDropLineAbove = drag !== null && drag.drop === index && drag.drop !== drag.from && drag.drop !== drag.from + 1;
                const showDropLineBelow = drag !== null && index === playlist.length - 1 && drag.drop === playlist.length && drag.from !== playlist.length - 1;

                return (
                  <div key={track.id} className="relative">
                  {showDropLineAbove && (
                    <div className="absolute -top-1 left-1 right-1 h-0.5 rounded-full bg-blue-400 shadow-[0_0_6px_rgba(96,165,250,0.9)] pointer-events-none z-10" />
                  )}
                  <div
                    data-track-row
                    className={`group relative flex items-center justify-between p-2.5 rounded-xl border transition-all ${
                      isCurrent
                        ? 'bg-blue-600/20 border-blue-500/70 shadow-lg'
                        : 'bg-slate-950/40 hover:bg-slate-800/60 border-slate-800 hover:border-slate-700'
                    } ${drag?.from === index ? 'opacity-50' : ''}`}
                  >
                    {/* Left: Drag handle (Editor), Play button / Number & Info */}
                    <div className="flex items-center gap-2.5 min-w-0 flex-1 pr-2">
                      {mode === 'editor' && (
                        <div
                          onPointerDown={(e) => startTrackDrag(e, index)}
                          onPointerMove={moveTrackDrag}
                          onPointerUp={() => endTrackDrag(true)}
                          onPointerCancel={() => endTrackDrag(false)}
                          className={`-ml-1 -mr-1.5 p-0.5 rounded text-slate-500 hover:text-slate-200 touch-none shrink-0 ${drag ? 'cursor-grabbing' : 'cursor-grab'}`}
                          title="Drag to reorder"
                        >
                          <GripVertical size={15} />
                        </div>
                      )}
                      <button
                        onClick={() => {
                          if (isCurrent && isPlaying) {
                            playlistEngine.pause();
                          } else if (isCurrent && isPaused) {
                            playlistEngine.resume();
                          } else if (viewedPlaylist) {
                            playlistEngine.playFromPlaylist(viewedPlaylist.id, index, 0);
                          }
                        }}
                        className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all cursor-pointer shrink-0 ${
                          isCurrentPlaying
                            ? 'bg-amber-500 text-slate-950 shadow-md'
                            : 'bg-slate-800 group-hover:bg-blue-600 text-slate-300 group-hover:text-white'
                        }`}
                        title={isCurrentPlaying ? 'Pause' : 'Play Track'}
                      >
                        {isCurrentPlaying ? (
                          <Pause size={13} />
                        ) : (
                          <Play size={13} className="fill-current ml-0.5" />
                        )}
                      </button>

                      <div className="flex flex-col min-w-0">
                        <span className={`text-xs font-bold truncate leading-tight ${
                          isCurrent ? 'text-white' : 'text-slate-200'
                        }`}>
                          {track.name}
                        </span>
                        <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
                          <span>#{index + 1}</span>
                          <span>·</span>
                          <span>{formatTime(trackDuration)}</span>
                          {track.volume !== 1.0 && (
                            <>
                              <span>·</span>
                              <span className="text-amber-400 flex items-center gap-0.5">
                                <Volume2 size={10} /> {Math.round(track.volume * 100)}%
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Right: Controls in Editor Mode (Settings, Reorder, Delete) */}
                    {mode === 'editor' && (
                      <div className="flex items-center gap-1 shrink-0">
                        {/* Settings Icon */}
                        <button
                          onClick={() => setSelectedTrackForEdit(track)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
                          title="Track Settings (Volume, Trimming, Rename)"
                        >
                          <Sliders size={14} />
                        </button>

                        {/* Delete */}
                        <button
                          onClick={() => removePlaylistTrack(track.id)}
                          className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-slate-800 transition-colors cursor-pointer"
                          title="Remove Track"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                  {showDropLineBelow && (
                    <div className="absolute -bottom-1 left-1 right-1 h-0.5 rounded-full bg-blue-400 shadow-[0_0_6px_rgba(96,165,250,0.9)] pointer-events-none z-10" />
                  )}
                  </div>
                );
              })
            )}
          </div>

          {/* Bottom Player Strip inside the expanded Drawer */}
          <div className="p-4 border-t border-slate-800 bg-slate-950/70 flex flex-col gap-2.5 shrink-0">
            {/* Current Track Info */}
            <div className="flex justify-between items-center text-xs">
              <span className="font-bold text-white truncate max-w-[200px]">
                {currentTrack ? currentTrack.name : 'No track selected'}
                {currentTrack && !isViewingPlaying && playingPlaylist && (
                  <span className="font-normal text-slate-400"> · {playingPlaylist.name}</span>
                )}
              </span>
              <span className="font-mono text-slate-400 text-[11px]">
                <span className="text-blue-400 font-bold">{formatTime(currentTime)}</span> / {formatTime(duration)}
              </span>
            </div>

            {/* Seekbar */}
            <input
              type="range"
              min="0"
              max={duration || 1}
              step="0.1"
              value={Math.min(duration || 1, currentTime)}
              onChange={(e) => playlistEngine.seek(parseFloat(e.target.value))}
              disabled={!currentTrack}
              className="w-full accent-blue-500 cursor-pointer h-2 bg-slate-800 rounded-lg disabled:opacity-40"
            />

            {/* Player Controls */}
            <div className="flex items-center justify-between pt-1">
              {/* Shuffle */}
              <button
                onClick={() => setPlaylistSettings({ shuffle: !playlistSettings.shuffle })}
                className={`p-2 rounded-xl transition-colors cursor-pointer ${
                  playlistSettings.shuffle
                    ? 'bg-blue-600/30 text-blue-400 border border-blue-500/40 shadow-sm'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
                title={playlistSettings.shuffle ? 'Shuffle: ON' : 'Shuffle: OFF'}
              >
                <Shuffle size={16} />
              </button>

              <div className="flex items-center gap-2">
                {/* Previous */}
                <button
                  onClick={() => playlistEngine.previous()}
                  disabled={transportTracks.length === 0}
                  className="p-2 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  title="Previous Track"
                >
                  <SkipBack size={18} />
                </button>

                {/* Play / Pause */}
                <button
                  onClick={handleMainPlay}
                  disabled={isViewingPlaying ? playingTracks.length === 0 : playlist.length === 0}
                  className={`p-3 rounded-full border shadow-lg transition-all active:scale-95 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                    isPlaying && isViewingPlaying
                      ? 'bg-amber-500 text-slate-950 border-amber-400 hover:bg-amber-400'
                      : 'bg-green-600 text-white border-green-500 hover:bg-green-500'
                  }`}
                  title={isViewingPlaying ? (isPlaying ? 'Pause' : 'Play') : `Play "${viewedPlaylist?.name ?? 'playlist'}"`}
                >
                  {isPlaying && isViewingPlaying ? <Pause size={20} /> : <Play size={20} className="fill-current ml-0.5" />}
                </button>

                {/* Next */}
                <button
                  onClick={() => playlistEngine.next()}
                  disabled={transportTracks.length === 0}
                  className="p-2 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  title="Next Track"
                >
                  <SkipForward size={18} />
                </button>
              </div>

              {/* Loop */}
              <button
                onClick={() => setPlaylistSettings({ loop: !playlistSettings.loop })}
                className={`p-2 rounded-xl transition-colors cursor-pointer ${
                  playlistSettings.loop
                    ? 'bg-purple-600/30 text-purple-400 border border-purple-500/40 shadow-sm'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
                title={playlistSettings.loop ? 'Loop: ON' : 'Loop: OFF'}
              >
                <Repeat size={16} />
              </button>
            </div>
          </div>
        </aside>
      )}
    </>
  );
}
