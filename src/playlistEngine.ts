import { useState, useEffect } from 'react';
import { audioEngine } from './audioEngine';
import { useAppStore } from './store';
import { PlaylistTrack } from './types';
import { getAudioBlob, saveAudioBlob } from './storage';

class PlaylistEngine {
  currentTrackIndex: number = -1;
  isPlaying: boolean = false;
  isPaused: boolean = false;
  currentTime: number = 0; // relative to trimStart, seconds
  duration: number = 0; // effective duration = trimEnd - trimStart, seconds

  private activeSource: {
    source: AudioBufferSourceNode;
    gain: GainNode;
    startTime: number;
    startOffset: number;
    trackId: string;
    duration: number;
  } | null = null;

  private outgoingSource: {
    source: AudioBufferSourceNode;
    gain: GainNode;
  } | null = null;

  private updateTimer: ReturnType<typeof setInterval> | null = null;
  // Set while a Fade Pause that was handed off to a new cue fades the playlist out
  private fadingOutForPause: boolean = false;
  private crossfadeScheduled: boolean = false;
  private listeners: Set<() => void> = new Set();
  private playedShuffleIndices: Set<number> = new Set();
  // Which playlist the transport is playing; it can differ from the one being viewed in the drawer
  playingPlaylistId: string | null = null;

  // The playing playlist's tracks; with nothing chosen yet, the viewed playlist becomes the playing one
  private getTracks(): PlaylistTrack[] {
    const { playlists, viewedPlaylistId } = useAppStore.getState();
    if (!this.playingPlaylistId || !playlists.some(p => p.id === this.playingPlaylistId)) {
      this.playingPlaylistId = viewedPlaylistId;
    }
    return playlists.find(p => p.id === this.playingPlaylistId)?.tracks ?? [];
  }

  // Play a track from a specific playlist. Switching playlists fades the old one out briefly.
  async playFromPlaylist(playlistId: string, index: number, seekTime: number = 0) {
    if (playlistId !== this.playingPlaylistId) {
      this.stopActiveAudio(0.5);
      this.playingPlaylistId = playlistId;
      this.currentTrackIndex = -1;
      this.currentTime = 0;
      this.duration = 0;
      this.crossfadeScheduled = false;
      this.playedShuffleIndices.clear();
      this.notify();
    }
    await this.playTrack(index, seekTime, 0.05);
  }

  // Start a playlist from the top (or a random track when shuffle is on)
  startPlaylist(playlistId: string) {
    const { playlists, playlistSettings } = useAppStore.getState();
    const tracks = playlists.find(p => p.id === playlistId)?.tracks ?? [];
    if (tracks.length === 0) return;
    const startIdx = playlistSettings.shuffle ? Math.floor(Math.random() * tracks.length) : 0;
    this.playFromPlaylist(playlistId, startIdx, 0);
  }

  // After tracks are reordered, point at the playing track's new position
  setCurrentTrackIndex(index: number) {
    this.currentTrackIndex = index;
    this.playedShuffleIndices.clear();
    if (index >= 0) this.playedShuffleIndices.add(index);
    this.notify();
  }

  // Called when a playlist is deleted; stops it if it was the one playing
  forgetPlaylist(playlistId: string) {
    if (this.playingPlaylistId !== playlistId) return;
    this.stop();
    this.playingPlaylistId = null;
    this.currentTrackIndex = -1;
    this.duration = 0;
    this.notify();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  notify() {
    this.listeners.forEach((cb) => {
      try {
        cb();
      } catch (e) {
        console.error('Error in playlistEngine listener:', e);
      }
    });
    try {
      audioEngine.notifyStateChange();
    } catch (e) {}
  }

  private startTicker() {
    if (this.updateTimer !== null) return;
    const tick = () => {
      if (this.isPlaying && this.activeSource && audioEngine.context) {
        const elapsed = audioEngine.context.currentTime - this.activeSource.startTime;
        const newTime = Math.min(this.duration, Math.max(0, this.activeSource.startOffset + elapsed));
        this.currentTime = newTime;

        const { playlistSettings } = useAppStore.getState();
        const playlist = this.getTracks();
        const xfade = playlistSettings.crossfadeDuration || 0;
        const timeRemaining = this.duration - newTime;

        // Auto-trigger crossfade to next track if remaining time <= xfade (only when not in global fade pause)
        if (
          !this.crossfadeScheduled &&
          !audioEngine.isFadingPause &&
          !this.fadingOutForPause &&
          xfade > 0 &&
          timeRemaining <= xfade &&
          timeRemaining > 0.1 &&
          playlist.length > 1
        ) {
          const nextIdx = this.getNextTrackIndex(false);
          if (nextIdx !== -1 && nextIdx !== this.currentTrackIndex) {
            this.crossfadeScheduled = true;
            // A late tick (background tab) crossfades over whatever time is left
            this.crossfadeToTrack(nextIdx, Math.min(xfade, timeRemaining));
          }
        }

        // Track ended naturally (when crossfade is 0 or single track or reached end)
        if (newTime >= this.duration && !this.crossfadeScheduled && !audioEngine.isFadingPause && !this.fadingOutForPause) {
          this.handleTrackNaturalEnd();
        }

        this.notify();
      }
    };
    // A timer rather than requestAnimationFrame: rAF stops entirely when the window is hidden
    // or minimized, which would stall the playlist. Timers keep running (throttled to ~1s at
    // worst), and the source's onended handler covers the end of a track in between.
    this.updateTimer = setInterval(tick, 50);
  }

  private stopTicker() {
    if (this.updateTimer !== null) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  private watchForEnd(source: AudioBufferSourceNode) {
    source.onended = () => {
      if (
        this.activeSource?.source === source &&
        this.isPlaying &&
        !this.crossfadeScheduled &&
        !audioEngine.isFadingPause &&
        !this.fadingOutForPause
      ) {
        this.handleTrackNaturalEnd();
      }
    };
  }

  // Fade the current track to silence without stopping it (the global Fade Pause pauses it after)
  fadeOut(seconds: number) {
    if (!this.activeSource || !audioEngine.context) return;
    this.fadingOutForPause = true;
    const gain = this.activeSource.gain.gain;
    const now = audioEngine.context.currentTime;
    try {
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(0, now + Math.max(0.02, seconds));
    } catch (e) {}
  }

  private getEffectiveTrackDuration(track: PlaylistTrack): number {
    let dur = (track.trimEnd || 0) - (track.trimStart || 0);
    if (dur <= 0) dur = track.duration || 0;
    return Math.max(0.1, dur);
  }

  getNextTrackIndex(isManual: boolean): number {
    const { playlistSettings } = useAppStore.getState();
    const playlist = this.getTracks();
    if (playlist.length === 0) return -1;
    if (playlist.length === 1) {
      return playlistSettings.loop || isManual ? 0 : -1;
    }

    if (playlistSettings.shuffle) {
      const unplayed: number[] = [];
      for (let i = 0; i < playlist.length; i++) {
        if (i !== this.currentTrackIndex && !this.playedShuffleIndices.has(i)) {
          unplayed.push(i);
        }
      }

      if (unplayed.length > 0) {
        const pick = unplayed[Math.floor(Math.random() * unplayed.length)];
        return pick;
      }

      // All tracks have been played in shuffle mode
      if (playlistSettings.loop || isManual) {
        this.playedShuffleIndices.clear();
        const candidates = playlist.map((_, i) => i).filter(i => i !== this.currentTrackIndex);
        return candidates[Math.floor(Math.random() * candidates.length)];
      }

      return -1;
    }

    // Sequential mode
    const nextIdx = this.currentTrackIndex + 1;
    if (nextIdx < playlist.length) {
      return nextIdx;
    }

    if (playlistSettings.loop || isManual) {
      return 0;
    }

    return -1;
  }

  getPreviousTrackIndex(): number {
    const { playlistSettings } = useAppStore.getState();
    const playlist = this.getTracks();
    if (playlist.length === 0) return -1;
    if (playlist.length === 1) return 0;

    const prevIdx = this.currentTrackIndex - 1;
    if (prevIdx >= 0) {
      return prevIdx;
    }

    if (playlistSettings.loop) {
      return playlist.length - 1;
    }

    return 0;
  }

  async playTrack(index: number, seekTime: number = 0, fadeInDuration: number = 0.05) {
    audioEngine.init();
    if (audioEngine.context && audioEngine.context.state === 'suspended') {
      await audioEngine.context.resume().catch(() => {});
    }

    const { nodes } = useAppStore.getState();
    const playlist = this.getTracks();
    if (index < 0 || index >= playlist.length) return;

    const track = playlist[index];
    if (!track) return;

    // Bring master volume back if a Fade Pause is running or finished; faded cues keep fading
    audioEngine.prepareForNewCue({ fromPlaylist: true });
    this.fadingOutForPause = false;

    // Stop current active source immediately with fast ramp
    this.stopActiveAudio(0.04);

    let audioUrl = track.audioUrl;

    // 1. If audioUrl is missing or invalid or scheme idb://, try to recover blob from IndexedDB or matching project node
    if (!audioUrl || audioUrl.startsWith('idb://')) {
      let blob = await getAudioBlob(`track-${track.id}`);
      if (!blob) {
        blob = await getAudioBlob(track.id);
      }
      if (!blob) {
        // Try finding matching node by name
        const matchingNode = nodes.find(n => n.type === 'audioNode' && (n.data as any)?.audioName === track.name);
        if (matchingNode) {
          blob = await getAudioBlob(matchingNode.id);
          if (blob) {
            await saveAudioBlob(`track-${track.id}`, blob);
          }
        }
      }
      if (blob) {
        audioUrl = URL.createObjectURL(blob);
        track.audioUrl = audioUrl;
        useAppStore.getState().updatePlaylistTrack(track.id, { audioUrl });
      }
    }

    // 2. Load the AudioBuffer via audioEngine (which also checks IndexedDB fallback)
    let buffer = await audioEngine.loadAudio(audioUrl || '', `track-${track.id}`);
    if (!buffer) {
      buffer = await audioEngine.loadAudio(audioUrl || '', track.id);
    }

    if (!buffer) {
      console.warn(`Could not load audio for track "${track.name}" (${track.id}).`);
      return;
    }

    if (!audioEngine.context || !audioEngine.masterGain) return;

    // Ensure track duration and trimEnd match real buffer length
    const realDur = buffer.duration;
    if (!track.duration || track.duration <= 0) {
      track.duration = realDur;
      useAppStore.getState().updatePlaylistTrack(track.id, { duration: realDur });
    }
    if (!track.trimEnd || track.trimEnd <= 0 || track.trimEnd > realDur) {
      track.trimEnd = realDur;
      useAppStore.getState().updatePlaylistTrack(track.id, { trimEnd: realDur });
    }

    this.currentTrackIndex = index;
    this.playedShuffleIndices.add(index);
    this.crossfadeScheduled = false;

    const trimStart = Math.max(0, Math.min(realDur - 0.05, track.trimStart || 0));
    const trimEnd = Math.max(trimStart + 0.1, Math.min(realDur, track.trimEnd || realDur));
    const effectiveDur = Math.max(0.1, trimEnd - trimStart);
    this.duration = effectiveDur;
    const clampedSeek = Math.max(0, Math.min(effectiveDur, seekTime));
    this.currentTime = clampedSeek;

    const source = audioEngine.context.createBufferSource();
    const gainNode = audioEngine.context.createGain();

    source.buffer = buffer;
    const targetVolume = (track.volume ?? 1.0);

    const now = audioEngine.context.currentTime;
    if (fadeInDuration > 0) {
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(targetVolume, now + fadeInDuration);
    } else {
      gainNode.gain.setValueAtTime(targetVolume, now);
    }

    source.connect(gainNode);
    gainNode.connect(audioEngine.getPlaylistOutput());

    const actualTrimStart = trimStart + clampedSeek;
    const remainingToPlay = effectiveDur - clampedSeek;
    const safeOffset = Math.max(0, Math.min(Math.max(0, realDur - 0.02), actualTrimStart));
    const safeDuration = Math.max(0.01, Math.min(realDur - safeOffset, remainingToPlay));

    try {
      source.start(now, safeOffset, safeDuration);
    } catch (err) {
      console.error('Error starting source with duration, trying without duration:', err);
      try {
        source.start(now, safeOffset);
      } catch (err2) {
        console.error('Fatal source start error:', err2);
        return;
      }
    }

    this.watchForEnd(source);
    this.activeSource = {
      source,
      gain: gainNode,
      startTime: now,
      startOffset: clampedSeek,
      trackId: track.id,
      duration: effectiveDur,
    };

    this.isPlaying = true;
    this.isPaused = false;

    this.startTicker();
    this.notify();
  }

  private async crossfadeToTrack(nextIndex: number, xfadeDuration: number) {
    audioEngine.init();
    const { nodes } = useAppStore.getState();
    const nextTrack = this.getTracks()[nextIndex];
    if (!nextTrack || !audioEngine.context || !audioEngine.masterGain) {
      this.handleTrackNaturalEnd();
      return;
    }

    let audioUrl = nextTrack.audioUrl;
    if (!audioUrl || audioUrl.startsWith('idb://')) {
      let blob = await getAudioBlob(`track-${nextTrack.id}`) || await getAudioBlob(nextTrack.id);
      if (!blob) {
        const matchingNode = nodes.find(n => n.type === 'audioNode' && (n.data as any)?.audioName === nextTrack.name);
        if (matchingNode) {
          blob = await getAudioBlob(matchingNode.id);
          if (blob) await saveAudioBlob(`track-${nextTrack.id}`, blob);
        }
      }
      if (blob) {
        audioUrl = URL.createObjectURL(blob);
        nextTrack.audioUrl = audioUrl;
        useAppStore.getState().updatePlaylistTrack(nextTrack.id, { audioUrl });
      }
    }

    let nextBuffer = await audioEngine.loadAudio(audioUrl || '', `track-${nextTrack.id}`);
    if (!nextBuffer) {
      nextBuffer = await audioEngine.loadAudio(audioUrl || '', nextTrack.id);
    }

    if (!nextBuffer) {
      this.handleTrackNaturalEnd();
      return;
    }

    // Move current active to outgoing with fade out
    if (this.activeSource) {
      const now = audioEngine.context.currentTime;
      try {
        this.activeSource.gain.gain.cancelScheduledValues(now);
        this.activeSource.gain.gain.setValueAtTime(this.activeSource.gain.gain.value, now);
        this.activeSource.gain.gain.linearRampToValueAtTime(0, now + xfadeDuration);
      } catch (e) {
        try { this.activeSource.gain.gain.value = 0; } catch (e2) {}
      }

      const oldSrc = this.activeSource;
      setTimeout(() => {
        try { oldSrc.source.stop(); } catch (e) {}
        try { oldSrc.gain.disconnect(); } catch (e) {}
      }, xfadeDuration * 1000 + 50);
    }

    // Start incoming track
    this.currentTrackIndex = nextIndex;
    this.playedShuffleIndices.add(nextIndex);
    this.crossfadeScheduled = false;

    const realDur = nextBuffer.duration;
    if (!nextTrack.duration || nextTrack.duration <= 0) {
      nextTrack.duration = realDur;
    }
    const trimStart = Math.max(0, Math.min(realDur - 0.05, nextTrack.trimStart || 0));
    const trimEnd = Math.max(trimStart + 0.1, Math.min(realDur, nextTrack.trimEnd || realDur));
    const nextDur = Math.max(0.1, trimEnd - trimStart);
    this.duration = nextDur;
    this.currentTime = 0;

    const source = audioEngine.context.createBufferSource();
    const gainNode = audioEngine.context.createGain();
    source.buffer = nextBuffer;

    const targetVolume = (nextTrack.volume ?? 1.0);
    const now = audioEngine.context.currentTime;

    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(targetVolume, now + xfadeDuration);

    source.connect(gainNode);
    gainNode.connect(audioEngine.getPlaylistOutput());

    const safeOffset = Math.max(0, Math.min(Math.max(0, realDur - 0.02), trimStart));
    const safeDuration = Math.max(0.01, Math.min(realDur - safeOffset, nextDur));

    try {
      source.start(now, safeOffset, safeDuration);
    } catch (err) {
      try { source.start(now, safeOffset); } catch (e) {}
    }

    this.watchForEnd(source);
    this.activeSource = {
      source,
      gain: gainNode,
      startTime: now,
      startOffset: 0,
      trackId: nextTrack.id,
      duration: nextDur,
    };

    this.isPlaying = true;
    this.isPaused = false;
    this.notify();
  }

  private handleTrackNaturalEnd() {
    const nextIdx = this.getNextTrackIndex(false);
    if (nextIdx !== -1) {
      this.playTrack(nextIdx, 0, 0.05);
    } else {
      this.stop();
    }
  }

  pause(fadeSeconds: number = 0.03) {
    if (!this.isPlaying) return;
    this.fadingOutForPause = false;
    this.stopActiveAudio(fadeSeconds);
    this.isPlaying = false;
    this.isPaused = true;
    this.stopTicker();
    this.notify();
  }

  resume(fadeInSeconds: number = 0.05) {
    if (this.currentTrackIndex >= 0) {
      if (this.currentTime >= this.duration - 0.1) {
        const nextIdx = this.getNextTrackIndex(true);
        if (nextIdx !== -1) {
          this.playTrack(nextIdx, 0, fadeInSeconds);
          return;
        }
      }
      this.playTrack(this.currentTrackIndex, this.currentTime, fadeInSeconds);
    } else {
      if (this.getTracks().length > 0) {
        this.playTrack(0, 0, fadeInSeconds);
      }
    }
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else if (this.isPaused && this.currentTrackIndex >= 0) {
      this.resume();
    } else {
      const { playlistSettings } = useAppStore.getState();
      const playlist = this.getTracks();
      if (playlist.length === 0) return;
      if (this.currentTrackIndex >= 0 && this.currentTrackIndex < playlist.length) {
        this.playTrack(this.currentTrackIndex, this.currentTime || 0);
      } else {
        const startIdx = playlistSettings.shuffle
          ? Math.floor(Math.random() * playlist.length)
          : 0;
        this.playTrack(startIdx, 0);
      }
    }
  }

  next() {
    const nextIdx = this.getNextTrackIndex(true);
    if (nextIdx !== -1) {
      this.playTrack(nextIdx, 0, 0.05);
    }
  }

  previous() {
    if (this.currentTime > 2.5) {
      this.seek(0);
      return;
    }
    const prevIdx = this.getPreviousTrackIndex();
    if (prevIdx !== -1) {
      this.playTrack(prevIdx, 0, 0.05);
    }
  }

  seek(targetSeconds: number) {
    const clamped = Math.max(0, Math.min(this.duration, targetSeconds));
    this.currentTime = clamped;
    if (this.isPlaying && this.currentTrackIndex >= 0) {
      this.playTrack(this.currentTrackIndex, clamped, 0.02);
    } else {
      this.notify();
    }
  }

  private stopActiveAudio(fadeDuration = 0.03) {
    if (this.activeSource && audioEngine.context) {
      const { source, gain } = this.activeSource;
      const now = audioEngine.context.currentTime;
      try {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + fadeDuration);
      } catch (e) {
        try { gain.gain.value = 0; } catch (e2) {}
      }
      setTimeout(() => {
        try { source.stop(); } catch (e) {}
        try { gain.disconnect(); } catch (e) {}
      }, fadeDuration * 1000 + 20);
      this.activeSource = null;
    }
  }

  stop() {
    this.stopActiveAudio(0.03);
    this.isPlaying = false;
    this.isPaused = false;
    this.currentTime = 0;
    this.crossfadeScheduled = false;
    this.stopTicker();
    this.notify();
  }
}

export const playlistEngine = new PlaylistEngine();

// Register playlistBridge with audioEngine so global transport controls (Instant Pause, Fade Pause, Resume) control the playlist
audioEngine.setPlaylistBridge({
  pause: (fadeSeconds?: number) => playlistEngine.pause(fadeSeconds),
  resume: (fadeInSeconds?: number) => playlistEngine.resume(fadeInSeconds),
  isPlaying: () => playlistEngine.isPlaying,
  isPaused: () => playlistEngine.isPaused,
  fadeOut: (seconds: number) => playlistEngine.fadeOut(seconds),
});

export function usePlaylistEngineState() {
  const [state, setState] = useState(() => ({
    currentTrackIndex: playlistEngine.currentTrackIndex,
    isPlaying: playlistEngine.isPlaying,
    isPaused: playlistEngine.isPaused,
    currentTime: playlistEngine.currentTime,
    duration: playlistEngine.duration,
    playingPlaylistId: playlistEngine.playingPlaylistId,
  }));

  useEffect(() => {
    const handleUpdate = () => {
      setState({
        currentTrackIndex: playlistEngine.currentTrackIndex,
        isPlaying: playlistEngine.isPlaying,
        isPaused: playlistEngine.isPaused,
        currentTime: playlistEngine.currentTime,
        duration: playlistEngine.duration,
        playingPlaylistId: playlistEngine.playingPlaylistId,
      });
    };
    return playlistEngine.subscribe(handleUpdate);
  }, []);

  return state;
}
