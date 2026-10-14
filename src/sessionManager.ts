import JSZip from 'jszip';
import { AppNode } from './store';
import { Edge } from '@xyflow/react';
import { AudioNodeData, PlaylistTrack, PlaylistSettings, NamedPlaylist, normalizePlaylists, getAllTracks } from './types';
import { v4 as uuidv4 } from 'uuid';
import { saveAudioBlob, getAudioBlob } from './storage';

export async function saveSession(
  nodes: AppNode[],
  edges: Edge[],
  globalVolume: number,
  playlists: NamedPlaylist[] = [],
  playlistSettings?: PlaylistSettings
) {
  const zip = new JSZip();
  const audioFolder = zip.folder("audio");

  // Clone nodes to avoid mutating the live state
  const nodesCopy = JSON.parse(JSON.stringify(nodes)) as AppNode[];

  for (const node of nodesCopy) {
    if (node.type === 'audioNode') {
      const data = node.data as AudioNodeData;
      if (data.audioUrl && !data.audioUrl.startsWith('audio/')) {
        try {
           let blob: Blob | null = await getAudioBlob(node.id);
           if (!blob) {
             const response = await fetch(data.audioUrl);
             blob = await response.blob();
           }
           if (blob) {
             const fileName = `${node.id}.blob`;
             audioFolder?.file(fileName, blob);
             data.audioUrl = `audio/${fileName}`;
           }
        } catch (e) {
           console.error("Failed to fetch audio for node", node.id, e);
        }
      }
    }
  }

  // Clone playlists
  const playlistsCopy = JSON.parse(JSON.stringify(playlists)) as NamedPlaylist[];
  await packTrackAudio(getAllTracks(playlistsCopy), audioFolder);

  const sessionData = {
    nodes: nodesCopy,
    edges,
    globalVolume,
    playlists: playlistsCopy,
    // Older versions of the app read only this field
    playlist: playlistsCopy[0]?.tracks ?? [],
    playlistSettings,
  };
  zip.file("session.json", JSON.stringify(sessionData, null, 2));

  const content = await zip.generateAsync({ type: "blob" });
  downloadBlob(content, "cuetrigger-show.zip");
}

export async function loadSession(file: File): Promise<{
  nodes: AppNode[];
  edges: Edge[];
  globalVolume: number;
  playlists: NamedPlaylist[];
  playlistSettings?: PlaylistSettings;
}> {
  const zip = await JSZip.loadAsync(file);
  const sessionFile = zip.file("session.json");
  if (!sessionFile) throw new Error("Invalid session file: missing session.json");

  const sessionData = JSON.parse(await sessionFile.async("string"));
  const { nodes, edges, globalVolume, playlistSettings } = sessionData;
  const playlists = normalizePlaylists(sessionData.playlists, sessionData.playlist);

  for (const node of nodes) {
    if (node.type === 'audioNode') {
      const data = node.data as AudioNodeData;
      if (data.audioUrl && data.audioUrl.startsWith('audio/')) {
        const audioFile = zip.file(data.audioUrl);
        if (audioFile) {
          const blob = await audioFile.async("blob");
          await saveAudioBlob(node.id, blob);
          const url = URL.createObjectURL(blob);
          data.audioUrl = url;
        }
      }
    }
  }

  await unpackTrackAudio(zip, getAllTracks(playlists));

  return { nodes, edges, globalVolume, playlists, playlistSettings };
}

// Put each track's audio in the zip and point the track at it
async function packTrackAudio(tracks: PlaylistTrack[], audioFolder: JSZip | null) {
  for (const track of tracks) {
    if (track.audioUrl && !track.audioUrl.startsWith('audio/')) {
      try {
        let blob: Blob | null = await getAudioBlob(`track-${track.id}`);
        if (!blob) {
          const response = await fetch(track.audioUrl);
          blob = await response.blob();
        }
        if (blob) {
          const fileName = `track-${track.id}.blob`;
          audioFolder?.file(fileName, blob);
          track.audioUrl = `audio/${fileName}`;
        }
      } catch (e) {
        console.error("Failed to fetch audio for playlist track", track.id, e);
      }
    }
  }
}

// Store each track's audio from the zip in the browser and give it a playable URL
async function unpackTrackAudio(zip: JSZip, tracks: PlaylistTrack[]) {
  for (const track of tracks) {
    if (track.audioUrl && track.audioUrl.startsWith('audio/')) {
      const audioFile = zip.file(track.audioUrl);
      if (audioFile) {
        const blob = await audioFile.async("blob");
        await saveAudioBlob(`track-${track.id}`, blob);
        track.audioUrl = URL.createObjectURL(blob);
      } else {
        track.audioUrl = null;
      }
    }
  }
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

// Export one playlist (tracks, trims, volumes and audio) as a zip
export async function exportPlaylist(playlist: NamedPlaylist) {
  const zip = new JSZip();
  const copy = JSON.parse(JSON.stringify(playlist)) as NamedPlaylist;
  await packTrackAudio(copy.tracks, zip.folder("audio"));
  zip.file("playlist.json", JSON.stringify({ name: copy.name, tracks: copy.tracks }, null, 2));
  const content = await zip.generateAsync({ type: "blob" });
  const safeName = copy.name.replace(/[^a-z0-9 _-]/gi, '').trim() || 'playlist';
  downloadBlob(content, `${safeName}.playlist.zip`);
}

// Import a playlist zip as a new playlist. Tracks get fresh ids so they never collide with existing ones.
export async function importPlaylist(file: File): Promise<NamedPlaylist> {
  const zip = await JSZip.loadAsync(file);
  const playlistFile = zip.file("playlist.json");
  if (!playlistFile) throw new Error("Invalid playlist file: missing playlist.json");
  const data = JSON.parse(await playlistFile.async("string"));
  const sourceTracks: PlaylistTrack[] = Array.isArray(data.tracks) ? data.tracks : [];

  const tracks: PlaylistTrack[] = sourceTracks.map((t) => ({ ...t, id: uuidv4() }));
  await unpackTrackAudio(zip, tracks);

  return {
    id: uuidv4(),
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : file.name.replace(/\.playlist\.zip$|\.zip$/i, ''),
    tracks,
  };
}
