'use client';

/**
 * useVoiceSession — Manages a LiveKit voice session for voice mode.
 *
 * Connects the browser's microphone/speaker to a LiveKit room where
 * a server-side voice agent (apps/aflow-voice) bridges audio to Phoenix
 * flow runs via STT → Phoenix API → TTS.
 *
 * The web client passes run context (currentRunId, stepExecutionId) via the
 * room token so the voice agent can resume an existing conversation.
 * The voice agent sends the runId back via data channel so the chat page
 * can subscribe to events and display messages.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Room, RemoteTrack, RemoteParticipant } from 'livekit-client';

export type VoiceSessionState = 'idle' | 'connecting' | 'active' | 'error';

interface VoiceSessionOptions {
  /** API base URL */
  apiUrl: string;
  /** Headers function for auth */
  headers: () => Record<string, string>;
  /** Agent ID to associate with this session */
  agentId: string;
  /** Current run ID (if resuming an existing conversation) */
  currentRunId?: string | null | undefined;
  /** Step execution ID for resume (if run is paused) */
  resumeStepExecutionId?: string | null | undefined;
  /** Called when the voice agent creates or resumes a run */
  onRunStarted?: (runId: string) => void;
}

export type VoiceMicMode = 'open' | 'push-to-talk';

interface VoiceSessionResult {
  /** Current session state */
  state: VoiceSessionState;
  /** Error message if state is 'error' */
  error: string | null;
  /** Start a voice session */
  connect: () => Promise<void>;
  /** End the voice session */
  disconnect: () => void;
  /** Whether the agent is currently speaking */
  isSpeaking: boolean;
  /** Current mic mode */
  micMode: VoiceMicMode;
  /** Toggle between open-mic and push-to-talk */
  setMicMode: (mode: VoiceMicMode) => void;
  /** Enable/disable mic (for push-to-talk) */
  setMicEnabled: (enabled: boolean) => void;
  /** Whether the mic is currently enabled */
  micEnabled: boolean;
}

export function useVoiceSession({
  apiUrl,
  headers,
  agentId,
  currentRunId,
  resumeStepExecutionId,
  onRunStarted,
}: VoiceSessionOptions): VoiceSessionResult {
  const [state, setState] = useState<VoiceSessionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [micMode, setMicMode] = useState<VoiceMicMode>('open');
  const [micEnabled, setMicEnabledState] = useState(true);
  // Debounce timer for speaking state — ActiveSpeakersChanged fires rapidly
  const speakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Store room ref
  const roomRef = useRef<Room | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const onRunStartedRef = useRef(onRunStarted);
  onRunStartedRef.current = onRunStarted;

  const setMicEnabled = useCallback((enabled: boolean) => {
    if (roomRef.current) {
      void roomRef.current.localParticipant.setMicrophoneEnabled(enabled);
      setMicEnabledState(enabled);
    }
  }, []);

  const disconnect = useCallback(() => {
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    if (roomRef.current) {
      void roomRef.current.disconnect();
      roomRef.current = null;
    }
    setState('idle');
    setIsSpeaking(false);
    setError(null);
  }, []);

  const connect = useCallback(async () => {
    if (state === 'connecting' || state === 'active') return;

    setState('connecting');
    setError(null);

    try {
      // 1. Get a room token — include current run context for resume
      console.info('[voice] Requesting room token...');
      const tokenRes = await fetch(`${apiUrl}/voice/token`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          agentId,
          // Pass current run context so voice agent can resume it
          ...(currentRunId ? { runId: currentRunId } : {}),
          ...(resumeStepExecutionId ? { stepExecutionId: resumeStepExecutionId } : {}),
        }),
      });

      if (!tokenRes.ok) {
        const body = (await tokenRes.json()) as { message?: string };
        throw new Error(body.message ?? `Failed to get voice token: ${tokenRes.status}`);
      }

      const { token, serverUrl } = (await tokenRes.json()) as {
        token: string;
        roomName: string;
        serverUrl: string;
      };

      console.info('[voice] Token received, serverUrl:', serverUrl);

      // 2. Dynamic import of livekit-client
      console.info('[voice] Loading LiveKit client...');
      const lk = await import('livekit-client');

      // 3. Create and connect to the room
      const room = new lk.Room({
        adaptiveStream: true,
        dynacast: true,
      });

      roomRef.current = room;

      // Attach audio elements for playback when agent publishes audio
      const handleTrackSubscribed = (
        track: RemoteTrack,
        _publication: unknown,
        participant: RemoteParticipant,
      ) => {
        console.info('[voice] Track subscribed:', track.kind, 'from', participant.identity);
        if (track.kind === lk.Track.Kind.Audio) {
          const element = track.attach();
          element.style.display = 'none';
          element.autoplay = true;
          element.volume = 1.0;
          document.body.appendChild(element);
          element.play().catch((e: unknown) => {
            console.warn('[voice] Audio autoplay blocked:', e);
          });
          console.info('[voice] Audio element attached and playing');
        }
      };

      const handleTrackUnsubscribed = (track: RemoteTrack) => {
        if (track.kind === lk.Track.Kind.Audio) {
          track.detach().forEach((el) => {
            el.remove();
          });
        }
      };

      // Track agent speaking state via ActiveSpeakersChanged — fires when
      // participants start/stop producing audio, not just when tracks subscribe.
      // Debounced: set speaking=true immediately, but delay speaking=false by 300ms
      // to avoid flickering during brief audio gaps.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic import types
      const handleActiveSpeakers = (speakers: any[]) => {
        const localIdentity = room.localParticipant?.identity;
        const agentSpeaking = speakers.some(
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
          (s: any) => s.identity !== localIdentity,
        );
        if (agentSpeaking) {
          // Speaking started — update immediately, cancel any pending off-timer
          if (speakingTimerRef.current) {
            clearTimeout(speakingTimerRef.current);
            speakingTimerRef.current = null;
          }
          setIsSpeaking(true);
        } else {
          // Speaking stopped — delay to avoid flickering
          if (!speakingTimerRef.current) {
            speakingTimerRef.current = setTimeout(() => {
              setIsSpeaking(false);
              speakingTimerRef.current = null;
            }, 300);
          }
        }
      };

      const handleDisconnected = () => {
        if (speakingTimerRef.current) {
          clearTimeout(speakingTimerRef.current);
          speakingTimerRef.current = null;
        }
        setState('idle');
        setIsSpeaking(false);
      };

      // Listen for data messages from the voice agent
      const handleDataReceived = (
        payload: Uint8Array,
        _participant: unknown,
        _kind: unknown,
        topic: string | undefined,
      ) => {
        try {
          const data = JSON.parse(new TextDecoder().decode(payload)) as {
            type?: string;
            sessionId?: string;
          };

          // Agent ready signal — transition from 'connecting' to 'active'
          if (topic === 'phoenix-voice' && data.type === 'ready') {
            console.info('[voice] Agent is ready, now listening');
            setState('active');
          }

          // Run context update — sync run ID from voice agent to chat UI
          if (topic === 'phoenix-run' && data.sessionId) {
            console.info('[voice] Agent started session:', data.sessionId);
            onRunStartedRef.current?.(data.sessionId);
          }
        } catch {
          // Ignore malformed data
        }
      };

      room.on(lk.RoomEvent.TrackSubscribed, handleTrackSubscribed);
      room.on(lk.RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
      room.on(lk.RoomEvent.ActiveSpeakersChanged, handleActiveSpeakers);
      room.on(lk.RoomEvent.Disconnected, handleDisconnected);
      room.on(lk.RoomEvent.DataReceived, handleDataReceived);

      cleanupRef.current = () => {
        room.off(lk.RoomEvent.TrackSubscribed, handleTrackSubscribed);
        room.off(lk.RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
        room.off(lk.RoomEvent.ActiveSpeakersChanged, handleActiveSpeakers);
        room.off(lk.RoomEvent.Disconnected, handleDisconnected);
        room.off(lk.RoomEvent.DataReceived, handleDataReceived);
      };

      // Connect with microphone enabled
      console.info('[voice] Connecting to LiveKit room...');
      await room.connect(serverUrl, token);
      console.info('[voice] Connected! Enabling microphone...');

      // In open-mic mode, enable mic immediately. In push-to-talk, start muted.
      const startWithMic = micMode === 'open';
      await room.localParticipant.setMicrophoneEnabled(startWithMic);
      setMicEnabledState(startWithMic);
      console.info(
        `[voice] Mic ${startWithMic ? 'enabled' : 'muted (push-to-talk)'}. Waiting for agent ready signal...`,
      );

      // Stay in 'connecting' — the agent sends a 'ready' message via data channel
      // when it's fully initialized and listening. That triggers setState('active').
      // Fallback: if we don't get a ready signal within 10s, assume active anyway.
      setTimeout(() => {
        setState((prev) => (prev === 'connecting' ? 'active' : prev));
      }, 10_000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect to voice';
      console.error('[voice] Connection failed:', message);
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      if (roomRef.current) {
        roomRef.current.disconnect().catch(() => {});
        roomRef.current = null;
      }
      setError(message);
      setState('error');
    }
  }, [apiUrl, headers, agentId, currentRunId, resumeStepExecutionId, state]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (roomRef.current) {
        roomRef.current.disconnect().catch(() => {});
      }
    };
  }, []);

  return {
    state,
    error,
    connect,
    disconnect,
    isSpeaking,
    micMode,
    setMicMode,
    setMicEnabled,
    micEnabled,
  };
}
