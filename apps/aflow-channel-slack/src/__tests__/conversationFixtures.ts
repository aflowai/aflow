/**
 * A fake Aflow for the conversation tests, served as `fetch` under the app's
 * real API client. It keeps the session routes' rules the app must meet: a
 * key may not start mode `chat`, and a resume must name the step the session
 * is paused on. The Helmsman answers each message at once, unless held.
 */
import { randomUUID } from 'node:crypto';

import { SPACE } from './cardFixtures.js';

export const HELMSMAN = 'cybernetic-helmsman';

export interface Start {
  spaceId: string | null;
  body: Record<string, unknown>;
  idempotencyKey: string | null;
}

export interface Resume {
  sessionId: string;
  body: Record<string, unknown>;
}

interface FakeSession {
  id: string;
  pausedStep: string | null;
  events: Array<Record<string, unknown>>;
}

export interface FakeAflow {
  fetch: typeof fetch;
  starts: Start[];
  resumes: Resume[];
  /** Every request refused, with the route's reason. */
  refusals: string[];
  sessions: Map<string, FakeSession>;
  /** While true, the Helmsman takes the message and has not answered yet. */
  holdAnswers: boolean;
  /** Answers every message held so far. */
  answerHeld(): void;
  /** Moves the session's pause on, as a reply from the web app would. */
  movePause(sessionId: string): void;
  /** Pauses the session on something only Aflow can answer, such as an approval. */
  pauseAtAflow(sessionId: string): void;
  /** Resumes the session's pause from the web app, as the operator would at Aflow. */
  resumeAtAflow(sessionId: string): void;
  /** Ends the session at Aflow with this event. */
  endSession(sessionId: string, eventType: string): void;
}

const MESSAGE_KEY = 'ai.agent.chatInput.helmsman';

export function fakeAflow(): FakeAflow {
  let clock = Date.parse('2026-11-01T09:00:00.000Z');
  const tick = () => new Date((clock += 1000)).toISOString();
  const byKey = new Map<string, string>();
  const held: Array<{ session: FakeSession; text: string }> = [];

  const pause = (session: FakeSession, text: string): void => {
    const step = randomUUID();
    session.pausedStep = step;
    session.events.push({
      eventId: randomUUID(),
      eventType: 'SessionPaused',
      sessionId: session.id,
      stepExecutionId: step,
      timestamp: tick(),
      metadata: {
        agentResponse: `The Helmsman answers: ${text}`,
        missingVariables: [{ variableId: MESSAGE_KEY }],
      },
    });
  };
  const take = (session: FakeSession, text: string): void => {
    session.pausedStep = null;
    session.events.push({
      eventId: randomUUID(),
      eventType: 'StepStarted',
      sessionId: session.id,
      timestamp: tick(),
    });
    if (aflow.holdAnswers) held.push({ session, text });
    else pause(session, text);
  };

  const json = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  const refuse = (status: number, message: string) => {
    aflow.refusals.push(message);
    return json(status, { error: 'BadRequest', message });
  };

  const aflow: FakeAflow = {
    starts: [],
    resumes: [],
    refusals: [],
    sessions: new Map(),
    holdAnswers: false,
    answerHeld() {
      for (const { session, text } of held.splice(0)) pause(session, text);
    },
    movePause(sessionId) {
      const session = aflow.sessions.get(sessionId);
      if (session !== undefined) pause(session, 'a message sent at Aflow');
    },
    pauseAtAflow(sessionId) {
      const session = aflow.sessions.get(sessionId);
      if (session === undefined) return;
      const step = randomUUID();
      session.pausedStep = step;
      session.events.push({
        eventId: randomUUID(),
        eventType: 'SessionPaused',
        sessionId: session.id,
        stepExecutionId: step,
        timestamp: tick(),
        metadata: { missingVariables: [{ variableId: 'approval' }] },
      });
    },
    resumeAtAflow(sessionId) {
      const session = aflow.sessions.get(sessionId);
      if (session !== undefined) take(session, 'a reply sent at Aflow');
    },
    endSession(sessionId, eventType) {
      const session = aflow.sessions.get(sessionId);
      if (session === undefined) return;
      session.pausedStep = null;
      session.events.push({
        eventId: randomUUID(),
        eventType,
        sessionId: session.id,
        timestamp: tick(),
      });
    },
    fetch: (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      if (headers.get('authorization') !== 'Bearer phx_owner') return refuse(401, 'no key');
      const body = (init?.body === undefined ? {} : JSON.parse(String(init.body))) as Record<
        string,
        unknown
      >;
      const path = url.pathname;

      if (method === 'GET' && path === '/v1/tenant') return json(200, { defaultSpaceId: SPACE });
      if (method === 'GET' && path === '/v1/spaces') {
        return json(200, {
          spaces: [
            { id: '00000000-0000-4000-8000-000000000000', myRole: null },
            { id: SPACE, myRole: 'admin' },
          ],
        });
      }

      if (method === 'POST' && path === '/v1/sessions') {
        aflow.starts.push({
          spaceId: url.searchParams.get('spaceId'),
          body,
          idempotencyKey: headers.get('idempotency-key'),
        });
        // `refusedStartMode`: a key is never an interactive sign-in.
        if (body['mode'] === 'chat' || body['mode'] === 'voice') {
          return refuse(400, `mode '${String(body['mode'])}' needs an interactive sign-in`);
        }
        const target = body['target'] as { kind?: string; systemRole?: string } | undefined;
        if (target?.kind !== 'platform-role' || target.systemRole !== HELMSMAN) {
          return refuse(400, 'not the Helmsman');
        }
        const key = headers.get('idempotency-key');
        const existing = key === null ? undefined : byKey.get(key);
        if (existing !== undefined) return json(201, { sessionId: existing, status: 'PAUSED' });
        const session: FakeSession = { id: randomUUID(), pausedStep: null, events: [] };
        aflow.sessions.set(session.id, session);
        if (key !== null) byKey.set(key, session.id);
        session.events.push({
          eventId: randomUUID(),
          eventType: 'SessionStarted',
          sessionId: session.id,
          timestamp: tick(),
        });
        take(session, String((body['input'] as { input?: unknown } | undefined)?.input));
        return json(201, { sessionId: session.id, status: 'RUNNING' });
      }

      const resume = /^\/v1\/sessions\/([^/]+)\/resume$/.exec(path);
      if (method === 'POST' && resume?.[1] !== undefined) {
        const session = aflow.sessions.get(resume[1]);
        aflow.resumes.push({ sessionId: resume[1], body });
        if (session === undefined) return refuse(404, 'no session');
        // `ResumeSessionRequestSchema`: the paused step is the resume's guard.
        if (typeof body['stepExecutionId'] !== 'string') {
          return refuse(400, 'stepExecutionId is required');
        }
        if (body['stepExecutionId'] !== session.pausedStep) {
          aflow.refusals.push('not paused at that step');
          return json(409, { error: 'Conflict', message: 'The session is not paused there.' });
        }
        take(session, String((body['input'] as { input?: unknown } | undefined)?.input));
        return json(200, { status: 'RUNNING', traceId: 't' });
      }

      const events = /^\/v1\/sessions\/([^/]+)\/events$/.exec(path);
      if (method === 'GET' && events?.[1] !== undefined) {
        const session = aflow.sessions.get(events[1]);
        if (session === undefined) return refuse(404, 'no session');
        const limit = Number(url.searchParams.get('limit'));
        return json(200, { events: session.events.slice(-limit), hasMore: false });
      }
      return refuse(404, `${method} ${path}`);
    },
  };
  return aflow;
}

let messages = 0;

/** A direct message from `user`, sent `ageMs` before `now`, with a timestamp of its own. */
export function directMessage(
  user: string,
  text: string,
  now: Date,
  options: { eventId?: string; ageMs?: number; threadTs?: string; ts?: string } = {},
) {
  messages += 1;
  const sent = ((now.getTime() - (options.ageMs ?? 2_000)) / 1000).toFixed(3);
  const ts = options.ts ?? `${sent}${String(messages % 1000).padStart(3, '0')}`;
  return {
    eventId: options.eventId ?? `Ev-${ts}`,
    slackUserId: user,
    slackTeamId: 'T1',
    channel: `D-${user}`,
    ts,
    text,
    ...(options.threadTs === undefined ? {} : { threadTs: options.threadTs }),
  };
}
