import { AppNode, useAppStore } from './store';
import { Edge } from '@xyflow/react';
import { AudioNodeData, PlaylistTrack, PlaylistSettings, NamedPlaylist, normalizePlaylists, getAllTracks } from './types';

const DB_NAME = 'cuetrigger_db';
// Shows saved before the app was renamed live here; they're copied over on first launch
const OLD_DB_NAME = 'theater_cue_db';
const DB_VERSION = 1;
const SESSION_STORE = 'session';
const AUDIO_STORE = 'audio_blobs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(name: string): Promise<{ db: IDBDatabase; created: boolean }> {
  return new Promise((resolve, reject) => {
    let created = false;
    const request = indexedDB.open(name, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      created = event.oldVersion === 0;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE);
      }
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE);
      }
    };

    request.onsuccess = () => resolve({ db: request.result, created });
    request.onerror = () => reject(request.error);
  });
}

async function oldDatabaseExists(): Promise<boolean> {
  if (!indexedDB.databases) return true; // can't tell; opening it below is harmless
  const list = await indexedDB.databases();
  return list.some((d) => d.name === OLD_DB_NAME);
}

// Copy every saved show and audio file from the pre-rename database into the new one.
// The old database is left untouched as a fallback.
async function copyFromOldDatabase(target: IDBDatabase): Promise<void> {
  if (!(await oldDatabaseExists())) return;
  const { db: old } = await openDatabase(OLD_DB_NAME);
  try {
    for (const storeName of [SESSION_STORE, AUDIO_STORE]) {
      if (!old.objectStoreNames.contains(storeName)) continue;
      const { keys, values } = await new Promise<{ keys: IDBValidKey[]; values: unknown[] }>((resolve, reject) => {
        const tx = old.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const keysReq = store.getAllKeys();
        const valuesReq = store.getAll();
        tx.oncomplete = () => resolve({ keys: keysReq.result, values: valuesReq.result });
        tx.onerror = () => reject(tx.error);
      });
      if (keys.length === 0) continue;
      await new Promise<void>((resolve, reject) => {
        const tx = target.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        keys.forEach((key, i) => store.put(values[i], key));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
  } finally {
    old.close();
  }
}

function getDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = (async () => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      throw new Error('IndexedDB is not supported');
    }
    const { db, created } = await openDatabase(DB_NAME);
    if (!created) return db;
    try {
      await copyFromOldDatabase(db);
      return db;
    } catch (err) {
      // Copy failed (e.g. disk full): keep using the old database so nothing goes missing
      console.error('Could not copy saved show to the new storage; using the old one:', err);
      db.close();
      indexedDB.deleteDatabase(DB_NAME);
      return (await openDatabase(OLD_DB_NAME)).db;
    }
  })().catch((err) => {
    dbPromise = null;
    throw err;
  });

  return dbPromise;
}

// Returns false if the audio could not be stored (e.g. disk quota), so callers can warn that
// the file won't survive a reload.
export async function saveAudioBlob(nodeId: string, blob: Blob): Promise<boolean> {
  try {
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE, 'readwrite');
      const store = tx.objectStore(AUDIO_STORE);
      store.put(blob, nodeId);
      // Quota errors surface on the transaction, after the put request itself succeeded
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch (err) {
    console.error(`Failed to save audio blob for node ${nodeId}:`, err);
    useAppStore.getState().setNotice(
      'Could not save an audio file to browser storage (it may be full). It will play now but will be missing after a reload. Save the session as a .zip as a backup.'
    );
    return false;
  }
}

// Ask the browser not to evict stored show audio when disk space runs low
export async function requestPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch (err) {
    console.warn('Persistent storage request failed:', err);
  }
}

export async function getAudioBlob(nodeId: string): Promise<Blob | null> {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE, 'readonly');
      const store = tx.objectStore(AUDIO_STORE);
      const req = store.get(nodeId);
      req.onsuccess = () => resolve((req.result as Blob) || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error(`Failed to get audio blob for node ${nodeId}:`, err);
    return null;
  }
}

export async function deleteAudioBlob(nodeId: string): Promise<void> {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE, 'readwrite');
      const store = tx.objectStore(AUDIO_STORE);
      const req = store.delete(nodeId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error(`Failed to delete audio blob for node ${nodeId}:`, err);
  }
}

export async function clearAllAudioBlobs(): Promise<void> {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE, 'readwrite');
      const store = tx.objectStore(AUDIO_STORE);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error('Failed to clear audio blobs:', err);
  }
}

export interface StoredSession {
  nodes: AppNode[];
  edges: Edge[];
  globalVolume: number;
  mode: 'editor' | 'performance';
  savedAt: number;
  playlist?: PlaylistTrack[]; // older saves: a single playlist
  playlists?: NamedPlaylist[];
  viewedPlaylistId?: string;
  playlistSettings?: PlaylistSettings;
}

export async function saveSessionToStorage(session: {
  nodes: AppNode[];
  edges: Edge[];
  globalVolume: number;
  mode: 'editor' | 'performance';
  playlists?: NamedPlaylist[];
  viewedPlaylistId?: string;
  playlistSettings?: PlaylistSettings;
}): Promise<void> {
  try {
    const db = await getDB();
    // Clone nodes so we don't save live object URLs in JSON
    const cleanNodes = session.nodes.map(n => {
      if (n.type === 'audioNode') {
        const data = { ...(n.data as AudioNodeData) };
        return {
          ...n,
          data: {
            ...data,
            audioUrl: data.audioUrl ? `idb://${n.id}` : null,
          }
        };
      }
      return n;
    });

    // Clone playlist so we don't save live object URLs
    const cleanPlaylists = (session.playlists ?? []).map(p => ({
      ...p,
      tracks: p.tracks.map(t => ({
        ...t,
        audioUrl: t.audioUrl ? `idb://track-${t.id}` : null,
      })),
    }));

    const storedData: StoredSession = {
      nodes: cleanNodes,
      edges: session.edges,
      globalVolume: session.globalVolume,
      mode: session.mode,
      savedAt: Date.now(),
      playlists: cleanPlaylists,
      viewedPlaylistId: session.viewedPlaylistId,
      playlistSettings: session.playlistSettings,
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readwrite');
      const store = tx.objectStore(SESSION_STORE);
      const req = store.put(storedData, 'current_session');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error('Failed to save session to storage:', err);
  }
}

export async function loadSessionFromStorage(): Promise<StoredSession | null> {
  try {
    const db = await getDB();
    const stored = await new Promise<StoredSession | null>((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readonly');
      const store = tx.objectStore(SESSION_STORE);
      const req = store.get('current_session');
      req.onsuccess = () => resolve((req.result as StoredSession) || null);
      req.onerror = () => reject(req.error);
    });

    if (!stored || !stored.nodes) return null;

    // Restore audio Blobs for each audioNode and generate fresh object URLs
    for (const node of stored.nodes) {
      if (node.type === 'audioNode') {
        const data = node.data as AudioNodeData;
        const blob = await getAudioBlob(node.id);
        if (blob) {
          const url = URL.createObjectURL(blob);
          data.audioUrl = url;
        } else {
          data.audioUrl = null;
        }
      }
    }

    // Restore audio Blobs for each playlist track
    stored.playlists = normalizePlaylists(stored.playlists, stored.playlist);
    delete stored.playlist;
    {
      for (const track of getAllTracks(stored.playlists)) {
        let blob = await getAudioBlob(`track-${track.id}`);
        if (!blob) {
          blob = await getAudioBlob(track.id);
        }
        if (!blob && stored.nodes) {
          const matchingNode = stored.nodes.find(n => n.type === 'audioNode' && (n.data as any)?.audioName === track.name);
          if (matchingNode) {
            blob = await getAudioBlob(matchingNode.id);
            if (blob) {
              await saveAudioBlob(`track-${track.id}`, blob);
            }
          }
        }
        if (blob) {
          track.audioUrl = URL.createObjectURL(blob);
        } else if (track.audioUrl && !track.audioUrl.startsWith('idb://')) {
          // Keep existing URL if valid
        } else {
          track.audioUrl = null;
        }
      }
    }

    return stored;
  } catch (err) {
    console.error('Failed to load session from storage:', err);
    return null;
  }
}

export async function clearStorage(): Promise<void> {
  try {
    const db = await getDB();
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(SESSION_STORE, 'readwrite');
        const store = tx.objectStore(SESSION_STORE);
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      }),
      clearAllAudioBlobs(),
    ]);
  } catch (err) {
    console.error('Failed to clear storage:', err);
  }
}
