import { useState, useEffect } from 'react';
import { AudioNodeData, TriggerBehavior } from './types';
import { getAudioBlob } from './storage';

export interface TriggerTracker {
  triggerId: string;
  totalDuration: number;
  contextStartTime: number;
  startOffset: number;
  isPaused: boolean;
  pausedAt: number;
}

export type AudioLoadStatus = 'loading' | 'ready' | 'missing';

interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  startTime: number;
  isCrossfadingOut: boolean;
  triggerId?: string;
  stoppedEarly: boolean;
  data: AudioNodeData;
  // Infinite loops can't schedule their fade-out up front, so it's applied when they're cut
  releaseFade: number;
}

// How far "Duck Others" cues pull everything else down, and how fast
const DUCK_LEVEL = 0.25;
const DUCK_DOWN_SECONDS = 0.3;
const DUCK_UP_SECONDS = 1.0;

// Cut cues pause the playlist with a quick fade and bring it back the same way when they end
const CUT_PLAYLIST_FADE_SECONDS = 0.5;

export interface PlaylistBridge {
  pause: (fadeSeconds?: number) => void;
  resume: (fadeInSeconds?: number) => void;
  isPlaying: () => boolean;
  isPaused: () => boolean;
  fadeOut: (seconds: number) => void;
}

class AudioEngine {
  context: AudioContext | null = null;
  masterGain: GainNode | null = null;
  limiter: DynamicsCompressorNode | null = null;
  analyser: AnalyserNode | null = null;
  activeSources: Set<ActiveSource> = new Set();
  audioBuffers: Map<string, AudioBuffer> = new Map();
  private pendingLoads: Map<string, Promise<AudioBuffer | null>> = new Map();
  audioStatus: Map<string, AudioLoadStatus> = new Map();
  lastGlobalVolume: number = 1;
  fadeTimeout: ReturnType<typeof setTimeout> | null = null;
  wasFadedPause: boolean = false;
  isFadingPause: boolean = false;
  triggerVolumeBoosts: Map<string, number> = new Map();
  triggerTrackers: Map<string, TriggerTracker> = new Map();
  private listeners: Set<() => void> = new Set();
  private sequenceRunner: ((triggerId: string, startSeekSeconds: number, isResumeAll?: boolean) => Promise<void>) | null = null;
  playlistBridge: PlaylistBridge | null = null;
  wasPlaylistPausedByGlobal: boolean = false;
  private fadeTargets: { triggerIds: Set<string>; playlist: boolean } | null = null;
  private fadeEndTime: number = 0;
  private fadeHandedOff: boolean = false;
  // Each cue plays through its own bus so it can be ducked independently; the playlist has a
  // volume bus feeding a duck bus. Everything ends at the master gain.
  private triggerBuses: Map<string, GainNode> = new Map();
  private playlistVolumeBus: GainNode | null = null;
  private playlistDuckBus: GainNode | null = null;
  private playlistVolume: number = 1;
  private duckTriggers: Set<string> = new Set();
  private duckTargets: Map<GainNode, number> = new Map();
  // Cut cues currently holding the playlist paused; it resumes once none of them is active
  private cutHolders: Set<string> = new Set();
  private cutReleaseTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  setSequenceRunner(runner: ((triggerId: string, startSeekSeconds: number, isResumeAll?: boolean) => Promise<void>) | null) {
    this.sequenceRunner = runner;
  }

  setPlaylistBridge(bridge: PlaylistBridge | null) {
    this.playlistBridge = bridge;
  }

  notifyStateChange() {
    this.updateDucking();
    this.scheduleCutReleaseCheck();
    this.listeners.forEach((cb) => {
      try {
        cb();
      } catch (err) {
        console.error('Error in audioEngine listener:', err);
      }
    });
  }

  init() {
    if (!this.context) {
      this.context = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.masterGain = this.context.createGain();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      // Brick-wall style limiter: only acts on peaks near full scale, so normal levels pass untouched
      this.limiter = this.context.createDynamicsCompressor();
      this.limiter.threshold.value = -1;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.1;
      this.masterGain.connect(this.limiter);
      this.limiter.connect(this.analyser);
      this.analyser.connect(this.context.destination);
      // Surface suspended/interrupted states (device unplugged, OS audio switch) to the UI
      this.context.onstatechange = () => this.notifyStateChange();
    }
    if (this.context && this.context.state === 'suspended') {
      this.context.resume().catch(() => {});
    }
  }

  getTriggerOutput(triggerId?: string): GainNode {
    if (!triggerId || !this.context || !this.masterGain) return this.masterGain!;
    let bus = this.triggerBuses.get(triggerId);
    if (!bus) {
      bus = this.context.createGain();
      bus.connect(this.masterGain);
      this.triggerBuses.set(triggerId, bus);
      this.updateDucking();
    }
    return bus;
  }

  getPlaylistOutput(): GainNode {
    this.init();
    if (!this.playlistVolumeBus && this.context && this.masterGain) {
      this.playlistDuckBus = this.context.createGain();
      this.playlistDuckBus.connect(this.masterGain);
      this.playlistVolumeBus = this.context.createGain();
      this.playlistVolumeBus.gain.value = this.playlistVolume;
      this.playlistVolumeBus.connect(this.playlistDuckBus);
      this.updateDucking();
    }
    return this.playlistVolumeBus ?? this.masterGain!;
  }

  setPlaylistVolume(volume: number) {
    this.playlistVolume = volume;
    if (this.playlistVolumeBus && this.context) {
      const now = this.context.currentTime;
      this.playlistVolumeBus.gain.cancelScheduledValues(now);
      this.playlistVolumeBus.gain.setValueAtTime(this.playlistVolumeBus.gain.value, now);
      this.playlistVolumeBus.gain.linearRampToValueAtTime(volume, now + 0.05);
    }
  }

  // Marks whether a cue is in "Duck Others" mode; takes effect immediately if it's playing
  setTriggerDuck(triggerId: string, duck: boolean) {
    if (duck === this.duckTriggers.has(triggerId)) return;
    if (duck) this.duckTriggers.add(triggerId);
    else this.duckTriggers.delete(triggerId);
    this.updateDucking();
  }

  isPlaylistHeldByCut(): boolean {
    return this.cutHolders.size > 0;
  }

  // A Cut cue started: fade the playlist out and keep it paused while the cue is active.
  // Only a playlist that is actually playing gets held; one paused on purpose stays paused.
  holdPlaylistForCut(triggerId: string) {
    if (this.cutHolders.size > 0) {
      this.cutHolders.add(triggerId);
      return;
    }
    if (!this.playlistBridge || !this.playlistBridge.isPlaying()) return;
    this.cutHolders.add(triggerId);
    this.playlistBridge.pause(CUT_PLAYLIST_FADE_SECONDS);
  }

  // Someone pressed play on the playlist themselves; it no longer waits for the Cut cue
  releaseCutHold() {
    this.cutHolders.clear();
  }

  // Checked shortly after state changes, so a cue restarting itself (seek, re-trigger) doesn't
  // briefly count as finished and bounce the playlist
  private scheduleCutReleaseCheck() {
    if (this.cutHolders.size === 0 || this.cutReleaseTimer !== null) return;
    this.cutReleaseTimer = setTimeout(() => {
      this.cutReleaseTimer = null;
      if (this.cutHolders.size === 0) return;
      // A paused Cut cue (e.g. after Space) still holds the playlist; finished or stopped ones don't
      for (const id of [...this.cutHolders]) {
        if (!this.triggerTrackers.has(id)) this.cutHolders.delete(id);
      }
      if (this.cutHolders.size === 0 && this.playlistBridge && this.playlistBridge.isPaused()) {
        this.playlistBridge.resume(CUT_PLAYLIST_FADE_SECONDS);
      }
    }, 60);
  }

  // While any "Duck Others" cue is playing, every other cue and the playlist sit at DUCK_LEVEL
  private updateDucking() {
    if (!this.context) return;
    const duckers = new Set<string>();
    this.triggerTrackers.forEach((tracker, id) => {
      if (!tracker.isPaused && this.duckTriggers.has(id)) duckers.add(id);
    });
    const ducking = duckers.size > 0;
    const apply = (bus: GainNode, target: number) => {
      if (this.duckTargets.get(bus) === target) return;
      this.duckTargets.set(bus, target);
      const now = this.context!.currentTime;
      try {
        bus.gain.cancelScheduledValues(now);
        bus.gain.setValueAtTime(bus.gain.value, now);
        bus.gain.linearRampToValueAtTime(target, now + (target < 1 ? DUCK_DOWN_SECONDS : DUCK_UP_SECONDS));
      } catch (e) {
        bus.gain.value = target;
      }
    };
    this.triggerBuses.forEach((bus, id) => apply(bus, ducking && !duckers.has(id) ? DUCK_LEVEL : 1));
    if (this.playlistDuckBus) apply(this.playlistDuckBus, ducking ? DUCK_LEVEL : 1);
  }

  getContextState(): string {
    return this.context ? this.context.state : 'suspended';
  }

  // Called whenever a new cue or playlist track starts. If a Fade Pause is running, the sounds
  // it was fading keep fading (the ramp moves from the master onto their own gains) while
  // the master comes back up so the new sound is audible. If a Fade Pause already finished,
  // the master is restored; the paused cues stay paused.
  prepareForNewCue(options: { fromPlaylist?: boolean } = {}) {
    if (options.fromPlaylist) this.releaseCutHold();
    if (!this.context || !this.masterGain) return;
    const now = this.context.currentTime;

    if (this.isFadingPause && this.fadeTargets) {
      const ratio = this.lastGlobalVolume > 0 ? this.masterGain.gain.value / this.lastGlobalVolume : 0;
      const end = Math.max(now + 0.02, this.fadeEndTime);
      this.activeSources.forEach((item) => {
        if (!item.triggerId || !this.fadeTargets!.triggerIds.has(item.triggerId)) return;
        try {
          const g = item.gain.gain.value;
          item.gain.gain.cancelScheduledValues(now);
          item.gain.gain.setValueAtTime(g * ratio, now);
          item.gain.gain.linearRampToValueAtTime(0, end);
        } catch (e) {}
      });
      if (options.fromPlaylist) {
        // The playlist is the new sound; don't pause it when the fade ends
        this.fadeTargets.playlist = false;
        this.wasPlaylistPausedByGlobal = false;
      } else if (this.fadeTargets.playlist && this.playlistBridge) {
        this.playlistBridge.fadeOut(end - now);
      }
      this.isFadingPause = false;
      this.fadeHandedOff = true;
    } else if (!this.wasFadedPause) {
      return;
    }

    this.wasFadedPause = false;
    try {
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.linearRampToValueAtTime(this.lastGlobalVolume, now + 0.02);
    } catch (e) {
      this.masterGain.gain.value = this.lastGlobalVolume;
    }
    this.notifyStateChange();
  }

  setGlobalVolume(volume: number) {
    this.lastGlobalVolume = volume;
    if (this.masterGain && this.context && !this.isFadingPause) {
      this.masterGain.gain.setValueAtTime(volume, this.context.currentTime);
    }
  }

  setTriggerVolumeBoost(triggerId: string, boost: number) {
    this.triggerVolumeBoosts.set(triggerId, boost);
    if (this.context) {
      this.activeSources.forEach((item) => {
        if (item.triggerId === triggerId) {
          const finalVol = item.data.volume * boost;
          item.gain.gain.setValueAtTime(finalVol, this.context!.currentTime);
        }
      });
    }
  }

  getTriggerVolumeBoost(triggerId?: string): number {
    if (!triggerId) return 1.0;
    return this.triggerVolumeBoosts.get(triggerId) ?? 1.0;
  }

  startTriggerTracker(triggerId: string, totalDuration: number, startOffsetSeconds: number = 0) {
    this.init();
    if (this.context && this.context.state === 'suspended') {
      this.context.resume().catch(() => {});
    }
    const now = this.context ? this.context.currentTime : 0;
    this.triggerTrackers.set(triggerId, {
      triggerId,
      totalDuration,
      contextStartTime: now - startOffsetSeconds,
      startOffset: startOffsetSeconds,
      isPaused: false,
      pausedAt: startOffsetSeconds,
    });
    this.notifyStateChange();
  }

  pauseTrigger(triggerId: string) {
    const tracker = this.triggerTrackers.get(triggerId);
    const currentTime = this.getTriggerCurrentTime(triggerId);
    if (tracker) {
      tracker.isPaused = true;
      tracker.pausedAt = currentTime;
    }

    const now = this.context ? this.context.currentTime : 0;
    const remainingSources: typeof this.activeSources = new Set();

    this.activeSources.forEach((item) => {
      if (item.triggerId === triggerId) {
        item.stoppedEarly = true;
        try {
          if (this.context) {
            item.gain.gain.cancelScheduledValues(now);
            item.gain.gain.setValueAtTime(item.gain.gain.value, now);
            item.gain.gain.linearRampToValueAtTime(0, now + 0.02);
          }
        } catch (e) {
          try { item.gain.gain.value = 0; } catch (e2) {}
        }
        setTimeout(() => {
          try { item.source.stop(); } catch (e) {}
          try { item.gain.disconnect(); } catch (e) {}
        }, 25);
      } else {
        remainingSources.add(item);
      }
    });

    this.activeSources = remainingSources;
    this.notifyStateChange();
  }

  resumeTrigger(triggerId: string) {
    const tracker = this.triggerTrackers.get(triggerId);
    if (tracker) {
      tracker.isPaused = false;
      const now = this.context ? this.context.currentTime : 0;
      tracker.contextStartTime = now - tracker.pausedAt;
    }
    this.notifyStateChange();
  }

  getTriggerState(triggerId: string): 'idle' | 'playing' | 'paused' {
    const tracker = this.triggerTrackers.get(triggerId);
    if (!tracker) {
      for (const item of this.activeSources) {
        if (item.triggerId === triggerId && !item.stoppedEarly) return 'playing';
      }
      return 'idle';
    }
    return tracker.isPaused ? 'paused' : 'playing';
  }

  isTriggerPaused(triggerId: string): boolean {
    return this.getTriggerState(triggerId) === 'paused';
  }

  isTriggerPlaying(triggerId: string): boolean {
    return this.getTriggerState(triggerId) === 'playing';
  }

  isTriggerActiveOrPaused(triggerId: string): boolean {
    return this.triggerTrackers.has(triggerId);
  }

  getTriggerCurrentTime(triggerId: string): number {
    const tracker = this.triggerTrackers.get(triggerId);
    if (!tracker) return 0;
    if (tracker.isPaused) {
      return tracker.pausedAt;
    }
    if (!this.context) return 0;
    const elapsed = this.context.currentTime - tracker.contextStartTime;
    return Math.min(tracker.totalDuration, Math.max(0, elapsed));
  }

  setTriggerTimelinePosition(triggerId: string, seconds: number) {
    const tracker = this.triggerTrackers.get(triggerId);
    if (!tracker) return;
    const clamped = Math.max(0, Math.min(tracker.totalDuration, seconds));
    tracker.pausedAt = clamped;
    if (!tracker.isPaused && this.context) {
      tracker.contextStartTime = this.context.currentTime - clamped;
    }
    this.notifyStateChange();
  }

  getTriggerTotalDuration(triggerId: string): number {
    return this.triggerTrackers.get(triggerId)?.totalDuration || 0;
  }

  stopTrigger(triggerId: string) {
    const now = this.context ? this.context.currentTime : 0;
    const remainingSources: typeof this.activeSources = new Set();

    this.activeSources.forEach((item) => {
      if (item.triggerId === triggerId) {
        item.stoppedEarly = true;
        try {
          if (this.context) {
            item.gain.gain.cancelScheduledValues(now);
            item.gain.gain.setValueAtTime(item.gain.gain.value, now);
            item.gain.gain.linearRampToValueAtTime(0, now + 0.02);
          }
        } catch (e) {
          try { item.gain.gain.value = 0; } catch (e2) {}
        }
        setTimeout(() => {
          try { item.source.stop(); } catch (e) {}
          try { item.gain.disconnect(); } catch (e) {}
        }, 25);
      } else {
        remainingSources.add(item);
      }
    });

    this.activeSources = remainingSources;
    this.triggerTrackers.delete(triggerId);
    this.notifyStateChange();
  }

  getPlayingTriggerIds(): string[] {
    const ids = new Set<string>();
    this.triggerTrackers.forEach((tracker, id) => {
      if (!tracker.isPaused) ids.add(id);
    });
    this.activeSources.forEach((src) => {
      if (src.triggerId && !src.stoppedEarly) {
        const tracker = this.triggerTrackers.get(src.triggerId);
        if (!tracker) {
          ids.add(src.triggerId);
        } else if (!tracker.isPaused) {
          ids.add(src.triggerId);
        }
      }
    });
    return Array.from(ids);
  }

  getPausedTriggerIds(): string[] {
    const ids = new Set<string>();
    this.triggerTrackers.forEach((tracker, id) => {
      if (tracker.isPaused) ids.add(id);
    });
    return Array.from(ids);
  }

  getActiveTriggerIds(): string[] {
    const ids = new Set<string>();
    this.triggerTrackers.forEach((_, id) => ids.add(id));
    this.activeSources.forEach((src) => {
      if (src.triggerId && !src.stoppedEarly) ids.add(src.triggerId);
    });
    return Array.from(ids);
  }

  async instantPause() {
    this.init();
    if (this.fadeTimeout) {
      clearTimeout(this.fadeTimeout);
      this.fadeTimeout = null;
    }
    this.isFadingPause = false;
    this.fadeTargets = null;
    this.fadeHandedOff = false;
    this.wasFadedPause = false;

    // Pause playlist if playing
    if (this.playlistBridge && this.playlistBridge.isPlaying()) {
      this.wasPlaylistPausedByGlobal = true;
      this.playlistBridge.pause();
    }

    // Restore master gain in case it was partway through a fade
    if (this.masterGain && this.context) {
      this.masterGain.gain.setValueAtTime(this.lastGlobalVolume, this.context.currentTime);
    }

    const now = this.context ? this.context.currentTime : 0;

    // Pause all currently playing triggers at their current timestamps
    this.triggerTrackers.forEach((tracker, id) => {
      if (!tracker.isPaused) {
        tracker.pausedAt = this.getTriggerCurrentTime(id);
        tracker.isPaused = true;
      }
    });

    // Safely stop all active audio sources
    this.activeSources.forEach((item) => {
      item.stoppedEarly = true;
      try {
        if (this.context) {
          item.gain.gain.cancelScheduledValues(now);
          item.gain.gain.setValueAtTime(item.gain.gain.value, now);
          item.gain.gain.linearRampToValueAtTime(0, now + 0.02);
        }
      } catch (e) {
        try { item.gain.gain.value = 0; } catch (e2) {}
      }
      setTimeout(() => {
        try { item.source.stop(); } catch (e) {}
        try { item.gain.disconnect(); } catch (e) {}
      }, 25);
    });

    this.activeSources.clear();
    this.notifyStateChange();
  }

  fadePause(duration = 4, onFadeComplete?: () => void) {
    this.init();
    if (!this.context || !this.masterGain) {
      if (onFadeComplete) onFadeComplete();
      return;
    }
    if (this.isFadingPause) return; // Prevent double trigger
    if (this.fadeTimeout) {
      clearTimeout(this.fadeTimeout);
      this.fadeTimeout = null;
    }

    const playlistPlaying = Boolean(this.playlistBridge && this.playlistBridge.isPlaying());
    if (playlistPlaying) {
      this.wasPlaylistPausedByGlobal = true;
    }

    const now = this.context.currentTime;
    const currentGain = this.masterGain.gain.value;
    this.isFadingPause = true;
    this.wasFadedPause = true;
    this.fadeHandedOff = false;
    this.fadeEndTime = now + duration;
    // Only what is playing now gets paused when the fade ends; anything fired during the fade keeps going
    this.fadeTargets = { triggerIds: new Set(this.getPlayingTriggerIds()), playlist: playlistPlaying };

    try {
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(currentGain, now);
      this.masterGain.gain.linearRampToValueAtTime(0, now + duration);
    } catch (e) {}

    this.notifyStateChange();

    this.fadeTimeout = setTimeout(() => {
      this.fadeTimeout = null;
      this.isFadingPause = false;
      const targets = this.fadeTargets;
      const handedOff = this.fadeHandedOff;
      this.fadeTargets = null;
      this.fadeHandedOff = false;

      // Pause the faded triggers at their exact reached positions
      this.triggerTrackers.forEach((tracker, id) => {
        if (!tracker.isPaused && (!handedOff || targets?.triggerIds.has(id))) {
          tracker.pausedAt = this.getTriggerCurrentTime(id);
          tracker.isPaused = true;
        }
      });

      const remaining: Set<ActiveSource> = new Set();
      this.activeSources.forEach((item) => {
        if (handedOff && !(item.triggerId && targets?.triggerIds.has(item.triggerId))) {
          remaining.add(item);
          return;
        }
        item.stoppedEarly = true;
        try { item.source.stop(); } catch (e) {}
        try { item.gain.disconnect(); } catch (e) {}
      });
      this.activeSources = remaining;

      if (this.playlistBridge && (handedOff ? targets?.playlist : (this.wasPlaylistPausedByGlobal || this.playlistBridge.isPlaying()))) {
        this.wasPlaylistPausedByGlobal = true;
        this.playlistBridge.pause();
      }

      // Master stays at 0 ready for a smooth resume, unless a new cue took over during the fade
      if (!handedOff && this.masterGain && this.context) {
        try {
          this.masterGain.gain.cancelScheduledValues(this.context.currentTime);
          this.masterGain.gain.setValueAtTime(0, this.context.currentTime);
        } catch (e) {}
      }

      if (onFadeComplete) onFadeComplete();
      this.notifyStateChange();
    }, duration * 1000);
  }

  async resumePlayback(targetVolume?: number) {
    this.init();
    if (!this.context || !this.masterGain) return;
    if (this.fadeTimeout) {
      clearTimeout(this.fadeTimeout);
      this.fadeTimeout = null;
    }
    this.isFadingPause = false;
    this.fadeTargets = null;
    this.fadeHandedOff = false;

    const vol = targetVolume !== undefined ? targetVolume : this.lastGlobalVolume;
    const now = this.context.currentTime;

    if (this.context.state === 'suspended') {
      await this.context.resume().catch(() => {});
    }

    const pausedIds = this.getPausedTriggerIds();
    const pausedPositions = new Map<string, number>();
    pausedIds.forEach((id) => {
      pausedPositions.set(id, this.getTriggerCurrentTime(id));
    });

    // Unpause all trackers and recalculate contextStartTime
    this.triggerTrackers.forEach((tracker) => {
      if (tracker.isPaused) {
        tracker.isPaused = false;
        tracker.contextStartTime = now - tracker.pausedAt;
      }
    });

    if (this.wasFadedPause) {
      this.wasFadedPause = false;
      const t = this.context.currentTime;
      try {
        this.masterGain.gain.cancelScheduledValues(t);
        this.masterGain.gain.setValueAtTime(0, t);
        this.masterGain.gain.linearRampToValueAtTime(vol, t + 0.3);
      } catch (e) {
        this.masterGain.gain.setValueAtTime(vol, t);
      }
    } else {
      try {
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setValueAtTime(vol, now);
      } catch (e) {}
    }

    // Resume playlist if it was paused by global pause or fade pause, or if it is currently paused,
    // unless a Cut cue is holding it (it comes back when that cue ends)
    if (this.playlistBridge && !this.isPlaylistHeldByCut() && (this.wasPlaylistPausedByGlobal || this.playlistBridge.isPaused())) {
      this.wasPlaylistPausedByGlobal = false;
      this.playlistBridge.resume();
    }

    this.notifyStateChange();

    // Trigger resume sequence for each previously paused trigger
    if (this.sequenceRunner) {
      pausedIds.forEach((id) => {
        const pos = pausedPositions.get(id) ?? 0;
        this.sequenceRunner!(id, pos, true);
      });
    }
  }

  async resetAll(targetVolume?: number) {
    if (this.fadeTimeout) {
      clearTimeout(this.fadeTimeout);
      this.fadeTimeout = null;
    }
    this.isFadingPause = false;
    this.fadeTargets = null;
    this.fadeHandedOff = false;
    this.wasFadedPause = false;

    // Reset cues and pads only (leaves playlist completely intact!)
    this.stopAll(0);

    const vol = targetVolume !== undefined ? targetVolume : this.lastGlobalVolume;
    if (this.context && this.masterGain) {
      if (this.context.state === 'suspended') {
        await this.context.resume().catch(() => {});
      }
      try {
        this.masterGain.gain.cancelScheduledValues(this.context.currentTime);
        this.masterGain.gain.setValueAtTime(vol, this.context.currentTime);
      } catch (e) {}
    }

    this.notifyStateChange();
  }

  getMeterLevel(): number {
    if (!this.analyser) return 0;
    const data = new Float32Array(this.analyser.frequencyBinCount);
    this.analyser.getFloatTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      sumSquares += data[i] * data[i];
    }
    const rms = Math.sqrt(sumSquares / data.length);
    return Math.min(1, rms * 5); // Boost visual scaling
  }

  getAudioStatus(id: string): AudioLoadStatus | undefined {
    return this.audioStatus.get(id);
  }

  private setAudioStatus(id: string, status: AudioLoadStatus) {
    if (!id || this.audioStatus.get(id) === status) return;
    this.audioStatus.set(id, status);
    this.notifyStateChange();
  }

  // Forget a cached buffer, e.g. after the file on an audio node is replaced
  invalidateAudio(id: string, url?: string | null) {
    const old = this.audioBuffers.get(id);
    this.audioBuffers.delete(id);
    if (url) this.audioBuffers.delete(url);
    if (old) {
      this.audioBuffers.forEach((buf, key) => {
        if (buf === old) this.audioBuffers.delete(key);
      });
    }
    this.pendingLoads.delete(id);
    this.audioStatus.delete(id);
    this.notifyStateChange();
  }

  clearAudioCache() {
    this.audioBuffers.clear();
    this.pendingLoads.clear();
    this.audioStatus.clear();
    this.notifyStateChange();
  }

  // Decode everything up front so the first press of a cue doesn't wait on decoding
  preloadAudio(items: { url: string | null; id: string }[]) {
    return Promise.all(
      items.map((item) => {
        if (!item.url) {
          this.setAudioStatus(item.id, 'missing');
          return Promise.resolve(null);
        }
        return this.loadAudio(item.url, item.id).catch(() => null);
      })
    );
  }

  async loadAudio(url: string, id: string): Promise<AudioBuffer | null> {
    this.init();
    if (!this.context) return null;

    if (id && this.audioBuffers.has(id)) {
      return this.audioBuffers.get(id)!;
    }
    if (url && this.audioBuffers.has(url)) {
      return this.audioBuffers.get(url)!;
    }

    // Share one decode between simultaneous requests (preload + a fast GO press)
    const key = id || url;
    const pending = this.pendingLoads.get(key);
    if (pending) return pending;

    this.setAudioStatus(id, 'loading');
    const promise = this.loadAudioUncached(url, id).then((buffer) => {
      if (this.pendingLoads.get(key) === promise) {
        this.pendingLoads.delete(key);
        if (buffer) {
          if (url) this.audioBuffers.set(url, buffer);
          if (id) this.audioBuffers.set(id, buffer);
        }
        this.setAudioStatus(id, buffer ? 'ready' : 'missing');
      }
      return buffer;
    });
    this.pendingLoads.set(key, promise);
    return promise;
  }

  private async loadAudioUncached(url: string, id: string): Promise<AudioBuffer | null> {
    if (!this.context) return null;

    // 1. Try fetching URL if it's a valid http or blob URL
    if (url && !url.startsWith('idb://')) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = await this.context.decodeAudioData(arrayBuffer);
          return audioBuffer;
        }
      } catch (error) {
        console.warn(`Fetch audio failed for ${id} (${url}), trying IndexedDB fallback:`, error);
      }
    }

    // 2. Fallback: check IndexedDB for the audio blob
    try {
      let blob = await getAudioBlob(id);
      if (!blob && id.startsWith('track-')) {
        blob = await getAudioBlob(id.replace('track-', ''));
      }
      if (!blob && !id.startsWith('track-')) {
        blob = await getAudioBlob(`track-${id}`);
      }
      if (blob) {
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await this.context.decodeAudioData(arrayBuffer);
        return audioBuffer;
      }
    } catch (err2) {
      console.error(`Failed to load audio from IndexedDB for ${id}:`, err2);
    }

    return null;
  }

  stopAll(fadeOutDuration = 0) {
    if (!this.context) return;
    const now = this.context.currentTime;

    this.activeSources.forEach((activeSource) => {
      activeSource.stoppedEarly = true;
      if (fadeOutDuration > 0) {
        try {
          activeSource.gain.gain.cancelScheduledValues(now);
          activeSource.gain.gain.setValueAtTime(activeSource.gain.gain.value, now);
          activeSource.gain.gain.linearRampToValueAtTime(0, now + fadeOutDuration);
        } catch (e) {
          try { activeSource.gain.gain.value = 0; } catch (e2) {}
        }
        setTimeout(() => {
          try { activeSource.source.stop(); } catch (e) {}
          try { activeSource.gain.disconnect(); } catch (e) {}
        }, fadeOutDuration * 1000);
      } else {
        try { activeSource.source.stop(); } catch (e) {}
        try { activeSource.gain.disconnect(); } catch (e) {}
      }
    });

    this.triggerTrackers.clear();
    this.activeSources.clear();
    this.notifyStateChange();
  }

  cutOtherTriggers(exceptTriggerId: string, fadeOutDuration = 0.04) {
    if (!this.context) return;
    const now = this.context.currentTime;

    const remainingSources: typeof this.activeSources = new Set();

    // Fast-fade and stop all active sources that belong to other triggers
    this.activeSources.forEach((activeSource) => {
      if (activeSource.triggerId === exceptTriggerId) {
        remainingSources.add(activeSource);
        return;
      }

      activeSource.stoppedEarly = true;
      // Infinite loops use their own fade-out when the next cue cuts them
      const fade = Math.max(fadeOutDuration, activeSource.releaseFade);

      try {
        if (this.context) {
          activeSource.gain.gain.cancelScheduledValues(now);
          activeSource.gain.gain.setValueAtTime(activeSource.gain.gain.value, now);
          activeSource.gain.gain.linearRampToValueAtTime(0, now + fade);
        }
      } catch (e) {
        try { activeSource.gain.gain.value = 0; } catch (e2) {}
      }

      setTimeout(() => {
        try { activeSource.source.stop(); } catch (e) {}
        try { activeSource.gain.disconnect(); } catch (e) {}
      }, Math.max(10, fade * 1000 + 20));
    });

    this.activeSources = remainingSources;

    // Remove trackers for all other triggers immediately so their sequence loops abort and tiles return to idle
    const toDelete: string[] = [];
    this.triggerTrackers.forEach((_, id) => {
      if (id !== exceptTriggerId) {
        toDelete.push(id);
      }
    });
    toDelete.forEach((id) => this.triggerTrackers.delete(id));

    this.notifyStateChange();
  }

  // Stop a single source (used by editor preview) without touching live cues
  stopSource(source: AudioBufferSourceNode) {
    const now = this.context ? this.context.currentTime : 0;
    this.activeSources.forEach((item) => {
      if (item.source !== source) return;
      item.stoppedEarly = true;
      try {
        item.gain.gain.cancelScheduledValues(now);
        item.gain.gain.setValueAtTime(item.gain.gain.value, now);
        item.gain.gain.linearRampToValueAtTime(0, now + 0.02);
      } catch (e) {}
      setTimeout(() => {
        try { item.source.stop(); } catch (e) {}
        try { item.gain.disconnect(); } catch (e) {}
      }, 25);
      this.activeSources.delete(item);
    });
    this.notifyStateChange();
  }

  playAudio(
    audioBuffer: AudioBuffer,
    data: AudioNodeData,
    behavior: TriggerBehavior = 'overlay',
    onComplete?: (stoppedEarly: boolean) => void,
    triggerId?: string,
    scheduledDelaySeconds: number = 0,
    seekOffsetSeconds: number = 0
  ) {
    this.init();
    if (!this.context || !this.masterGain) return null;

    if (behavior === 'cut' && triggerId) {
      // Cut all other triggers immediately
      this.cutOtherTriggers(triggerId, 0.04);
    }

    const source = this.context.createBufferSource();
    const gainNode = this.context.createGain();

    source.buffer = audioBuffer;
    // All times below are in real (context) seconds; buffer positions are scaled by the playback rate
    const rate = data.pitch > 0 ? data.pitch : 1;
    source.playbackRate.value = rate;

    const boost = this.getTriggerVolumeBoost(triggerId);
    const finalVolume = data.volume * boost;

    source.connect(gainNode);
    gainNode.connect(this.getTriggerOutput(triggerId));

    const now = this.context.currentTime;
    const delay = Math.max(0, scheduledDelaySeconds + (data.startDelay || 0));
    const startTime = now + delay;

    const trimStart = Math.max(0, Math.min(audioBuffer.duration, data.trimStart || 0));
    let trimEnd = data.trimEnd && data.trimEnd > trimStart ? Math.min(data.trimEnd, audioBuffer.duration) : audioBuffer.duration;
    if (trimEnd <= trimStart) trimEnd = audioBuffer.duration;
    const passBufferDuration = trimEnd - trimStart;
    const seekBuffer = Math.max(0, seekOffsetSeconds) * rate;

    const isInfinite = data.loopCount === -1;
    const passes = data.loopCount && data.loopCount > 0 ? data.loopCount + 1 : 1;
    const totalBuffer = passBufferDuration * passes;

    if (passBufferDuration <= 0 || (!isInfinite && seekBuffer >= totalBuffer)) {
      try { gainNode.disconnect(); } catch (e) {}
      if (onComplete) onComplete(false);
      return null;
    }

    // Where in the file to start, wrapping into later loop passes when resuming mid-loop
    const offsetInPass = isInfinite || passes > 1 ? seekBuffer % passBufferDuration : seekBuffer;
    const startOffset = trimStart + offsetInPass;
    const playRealDuration = isInfinite ? Infinity : (totalBuffer - seekBuffer) / rate;
    const endTime = startTime + playRealDuration;

    // Fades are in real seconds. If fade-in and fade-out would overlap, each gets half the time.
    const elapsedReal = Math.max(0, seekOffsetSeconds);
    let fadeIn = Math.max(0, data.fadeIn || 0);
    let fadeOut = isInfinite ? 0 : Math.max(0, data.fadeOut || 0);
    const fullReal = totalBuffer / rate;
    if (!isInfinite && fadeIn + fadeOut > fullReal) {
      fadeIn = Math.min(fadeIn, fullReal / 2);
      fadeOut = Math.min(fadeOut, fullReal / 2);
    }

    const gain = gainNode.gain;
    gain.value = 0;
    if (fadeIn > 0 && elapsedReal < fadeIn) {
      gain.setValueAtTime(finalVolume * (elapsedReal / fadeIn), startTime);
      gain.linearRampToValueAtTime(finalVolume, startTime + (fadeIn - elapsedReal));
    } else {
      gain.setValueAtTime(finalVolume, startTime);
    }

    if (fadeOut > 0) {
      const fadeOutStart = endTime - fadeOut;
      if (fadeOutStart > startTime) {
        gain.setValueAtTime(finalVolume, Math.max(fadeOutStart, startTime + Math.max(0, fadeIn - elapsedReal)));
        gain.linearRampToValueAtTime(0, endTime);
      } else {
        // Resumed inside the fade-out: start at the matching level and finish the ramp
        gain.setValueAtTime(finalVolume * ((endTime - startTime) / fadeOut), startTime);
        gain.linearRampToValueAtTime(0, endTime);
      }
    }

    if (isInfinite || passes > 1) {
      source.loop = true;
      source.loopStart = trimStart;
      source.loopEnd = trimEnd;
      source.start(startTime, startOffset);
      if (!isInfinite) source.stop(endTime);
    } else {
      source.start(startTime, startOffset, passBufferDuration - seekBuffer);
    }

    const activeItem: ActiveSource = {
      source,
      gain: gainNode,
      startTime,
      isCrossfadingOut: false,
      triggerId,
      stoppedEarly: false,
      data,
      releaseFade: isInfinite ? Math.max(0, data.fadeOut || 0) : 0,
    };
    this.activeSources.add(activeItem);

    source.onended = () => {
      this.activeSources.delete(activeItem);
      if (onComplete && !activeItem.isCrossfadingOut) {
        onComplete(activeItem.stoppedEarly);
      }
    };

    return source;
  }
}

export const audioEngine = new AudioEngine();

export function useAudioEngineState() {
  const [state, setState] = useState(() => ({
    playingIds: audioEngine.getPlayingTriggerIds(),
    pausedIds: audioEngine.getPausedTriggerIds(),
    isFadingPause: audioEngine.isFadingPause,
  }));

  useEffect(() => {
    const handleUpdate = () => {
      setState({
        playingIds: audioEngine.getPlayingTriggerIds(),
        pausedIds: audioEngine.getPausedTriggerIds(),
        isFadingPause: audioEngine.isFadingPause,
      });
    };
    return audioEngine.subscribe(handleUpdate);
  }, []);

  return state;
}
