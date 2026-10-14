export type TriggerBehavior = 'overlay' | 'duck' | 'cut';

export interface TriggerNodeData extends Record<string, unknown> {
  title: string;
  keyTrigger: string;
  behavior: TriggerBehavior;
  onTrigger?: () => void;
  performanceIndex?: number;
  volumeBoost?: number;
  color?: string;
}

export interface AudioNodeData extends Record<string, unknown> {
  audioUrl: string | null;
  audioName: string | null;
  volume: number; // 0 to 2
  pitch: number; // 0.5 to 2
  loopCount: number; // -1 for infinite, 0 for none, >0 for specific
  startDelay: number; // seconds
  trimStart: number; // seconds
  trimEnd: number; // seconds
  duration: number; // seconds (original length)
  normalize: boolean;
  fadeIn: number; // seconds
  fadeOut: number; // seconds
  onPlayStart?: () => void;
  onPlayComplete?: () => void;
}

export interface CrossFadeNodeData extends Record<string, unknown> {
  duration: number; // seconds
}

export interface PlaylistTrack {
  id: string;
  name: string;
  audioUrl: string | null;
  audioBlobId?: string;
  duration: number; // original audio buffer length in seconds
  trimStart: number; // seconds
  trimEnd: number; // seconds
  volume: number; // 0 to 1.5
}

export interface NamedPlaylist {
  id: string;
  name: string;
  tracks: PlaylistTrack[];
}

export const DEFAULT_PLAYLIST_ID = 'default';

// Older saves only have a single track list; it becomes the Default playlist
export function normalizePlaylists(playlists?: NamedPlaylist[] | null, legacyTracks?: PlaylistTrack[] | null): NamedPlaylist[] {
  if (playlists && playlists.length > 0) return playlists;
  return [{ id: DEFAULT_PLAYLIST_ID, name: 'Default', tracks: legacyTracks ?? [] }];
}

export function getAllTracks(playlists: NamedPlaylist[]): PlaylistTrack[] {
  return playlists.flatMap((p) => p.tracks);
}

export interface PlaylistSettings {
  crossfadeDuration: number; // in seconds (e.g. 0 to 12s, default 2s)
  shuffle: boolean;
  loop: boolean;
  volume?: number; // 0 to 1.5, playlist-only level (default 1)
}

export type AppNodeData = TriggerNodeData | AudioNodeData | CrossFadeNodeData;
