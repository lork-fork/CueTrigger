import { useAppStore, AppNode } from './store';
import { Edge } from '@xyflow/react';
import { audioEngine } from './audioEngine';
import { TriggerNodeData, AudioNodeData, CrossFadeNodeData } from './types';

export interface TimelineSegment {
  nodeId: string;
  type: string;
  audioUrl?: string | null;
  audioName?: string | null;
  data: AudioNodeData;
  duration: number;
  startOffset: number;
  endOffset: number;
  crossfadeIn: number;
  crossfadeOut: number;
}

// Real-time length of one audio node (trim, loops and pitch applied). Infinite loops count as one pass.
function getPlayDuration(data: AudioNodeData): number {
  let playDuration = Math.max(0, (data.trimEnd || 0) - (data.trimStart || 0));
  if (playDuration <= 0) playDuration = data.duration || 0;
  if (data.loopCount && data.loopCount > 0) {
    playDuration *= (data.loopCount + 1);
  }
  const rate = data.pitch > 0 ? data.pitch : 1;
  return playDuration / rate;
}

export function getTriggerSegments(triggerId: string, nodes: AppNode[], edges: Edge[]): { segments: TimelineSegment[]; totalDuration: number } {
  const segments: TimelineSegment[] = [];
  const visited = new Set<string>();

  const directEdges = edges.filter(e => e.source === triggerId);
  const queue: { nodeId: string; startTime: number; parent: TimelineSegment | null; crossfadeIn: number }[] = [];

  for (const edge of directEdges) {
    queue.push({ nodeId: edge.target, startTime: 0, parent: null, crossfadeIn: 0 });
  }

  let maxTotalDuration = 0;

  while (queue.length > 0) {
    const { nodeId, startTime, parent, crossfadeIn } = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = nodes.find(n => n.id === nodeId);
    if (!node) continue;

    if (node.type === 'audioNode') {
      const data = node.data as AudioNodeData;
      const playDuration = getPlayDuration(data);
      const dur = (data.startDelay || 0) + playDuration;
      const startOffset = startTime + (data.startDelay || 0);
      const endOffset = startOffset + playDuration;

      const segment: TimelineSegment = {
        nodeId: node.id,
        type: 'audioNode',
        audioUrl: data.audioUrl,
        audioName: data.audioName,
        data,
        duration: dur,
        startOffset,
        endOffset,
        crossfadeIn: Math.min(crossfadeIn, playDuration),
        crossfadeOut: 0,
      };
      segments.push(segment);

      if (endOffset > maxTotalDuration) {
        maxTotalDuration = endOffset;
      }

      const nextEdges = edges.filter(e => e.source === nodeId);
      for (const edge of nextEdges) {
        queue.push({ nodeId: edge.target, startTime: endOffset, parent: segment, crossfadeIn: 0 });
      }
    } else if (node.type === 'crossFadeNode') {
      const data = node.data as CrossFadeNodeData;
      let xfadeDur = data.duration || 1;
      if (parent) {
        // Can't crossfade for longer than the outgoing sound plays
        xfadeDur = Math.min(xfadeDur, parent.endOffset - parent.startOffset);
        parent.crossfadeOut = Math.max(parent.crossfadeOut, xfadeDur);
      }
      const nextEdges = edges.filter(e => e.source === nodeId);
      for (const edge of nextEdges) {
        queue.push({ nodeId: edge.target, startTime: Math.max(0, startTime - xfadeDur), parent, crossfadeIn: xfadeDur });
      }
    }
  }

  segments.sort((a, b) => a.startOffset - b.startOffset);
  return { segments, totalDuration: maxTotalDuration };
}

// Each start of a trigger gets a new generation; an older run that is still loading
// sees it's been superseded and schedules nothing (prevents doubled audio on fast presses).
const runGenerations = new Map<string, number>();

export async function executeSequence(triggerId: string, startSeekSeconds: number = 0, isResumeAll: boolean = false) {
  const generation = (runGenerations.get(triggerId) ?? 0) + 1;
  runGenerations.set(triggerId, generation);
  const isCurrentRun = () => runGenerations.get(triggerId) === generation;

  audioEngine.init();
  if (audioEngine.context && audioEngine.context.state === 'suspended') {
    await audioEngine.context.resume().catch(() => {});
  }
  if (!isCurrentRun()) return;

  // A new GO after (or during) a Fade Pause must be audible
  if (!isResumeAll) {
    audioEngine.prepareForNewCue();
  }

  const { nodes, edges } = useAppStore.getState();
  const triggerNode = nodes.find(n => n.id === triggerId);
  const triggerData = triggerNode?.data as TriggerNodeData | undefined;
  const isCutMode = triggerData?.behavior === 'cut';
  audioEngine.setTriggerDuck(triggerId, triggerData?.behavior === 'duck');
  // Use the cue's saved volume, so it plays at what its slider shows even right after a reload
  if (triggerData) audioEngine.setTriggerVolumeBoost(triggerId, triggerData.volumeBoost ?? 1);

  // If in 'cut' mode and not resuming all, cut all other triggers immediately
  if (isCutMode && !isResumeAll) {
    audioEngine.cutOtherTriggers(triggerId, 0.04);
  }

  const { segments, totalDuration } = getTriggerSegments(triggerId, nodes, edges);
  if (segments.length === 0) return;

  const playable = segments.filter(seg => Boolean(seg.audioUrl) && seg.endOffset > startSeekSeconds);
  if (playable.length === 0) {
    audioEngine.stopTrigger(triggerId);
    return;
  }

  // Stop previous sources for this trigger
  audioEngine.stopTrigger(triggerId);

  // Start tracker now so the tile shows as playing (and can be paused) while audio loads
  audioEngine.startTriggerTracker(triggerId, totalDuration, startSeekSeconds);
  if (isCutMode && !isResumeAll) {
    // Cut also takes out the playlist, but softly: it fades and waits until this cue ends
    audioEngine.holdPlaylistForCut(triggerId);
  }

  // Load everything in parallel (usually instant, since buffers are preloaded)
  const buffers = await Promise.all(
    playable.map(seg => audioEngine.loadAudio(seg.audioUrl!, seg.nodeId).catch(() => null))
  );

  // Abort if superseded, stopped, paused, or cut while loading
  if (!isCurrentRun() || !audioEngine.isTriggerActiveOrPaused(triggerId) || audioEngine.isTriggerPaused(triggerId)) {
    return;
  }

  const toSchedule = playable
    .map((seg, i) => ({ seg, buffer: buffers[i] }))
    .filter((item): item is { seg: TimelineSegment; buffer: AudioBuffer } => item.buffer !== null);

  if (toSchedule.length === 0) {
    // Nothing could be loaded; the missing-audio warning on the tile explains why
    audioEngine.stopTrigger(triggerId);
    return;
  }

  // Re-anchor the timeline to now so it matches what's heard, regardless of load time
  audioEngine.startTriggerTracker(triggerId, totalDuration, startSeekSeconds);

  if (isCutMode && !isResumeAll) {
    audioEngine.cutOtherTriggers(triggerId, 0.04);
  }

  let completedCount = 0;
  let scheduledCount = 0;
  let schedulingDone = false;

  // Scheduled in one synchronous pass, so every segment shares the same start time
  for (const { seg, buffer } of toSchedule) {
    const scheduledDelay = Math.max(0, seg.startOffset - startSeekSeconds);
    const seekOffset = startSeekSeconds > seg.startOffset
      ? startSeekSeconds - seg.startOffset
      : 0;

    const data: AudioNodeData = {
      ...seg.data,
      // The segment's start offset already includes the start delay; applying it again in
      // playAudio made the node start twice as late and overlap whatever came after it
      startDelay: 0,
      fadeIn: Math.max(seg.data.fadeIn || 0, seg.crossfadeIn),
      fadeOut: Math.max(seg.data.fadeOut || 0, seg.crossfadeOut),
    };

    const source = audioEngine.playAudio(
      buffer,
      data,
      // Cut already happened above; per-segment cutting would also cut sounds started by a cue fired mid-load
      'overlay',
      (stoppedEarly: boolean) => {
        // Segments that had nothing left to play report back synchronously; they aren't counted
        if (!schedulingDone) return;
        completedCount++;
        if (completedCount >= scheduledCount && !stoppedEarly && isCurrentRun()) {
          const state = audioEngine.getTriggerState(triggerId);
          if (state !== 'paused') {
            audioEngine.stopTrigger(triggerId);
          }
        }
      },
      triggerId,
      scheduledDelay,
      seekOffset
    );
    if (source) scheduledCount++;
  }

  schedulingDone = true;

  if (scheduledCount === 0) {
    audioEngine.stopTrigger(triggerId);
  }
}

// Automatically register this global sequence runner with audioEngine
audioEngine.setSequenceRunner((triggerId, startSeekSeconds, isResumeAll) => {
  return executeSequence(triggerId, startSeekSeconds, isResumeAll);
});
