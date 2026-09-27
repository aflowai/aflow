'use client';

import { useCallback, useState } from 'react';
import { useApiMutation } from './useApiQuery.js';

interface PostRoomMessageBody {
  body: string;
  clientMessageId?: string;
  wake?: boolean;
}

interface PostRoomMessageResult {
  messageSeq: number;
  eventId: string;
  postedAt: string;
  woke: boolean;
}

/**
 * Say something in a room without taking the wheel.
 *
 * The composer used to lock while the agent worked, so a team could only talk
 * in the gaps between turns — which is most of what there is to say. Posting
 * appends to the same timeline in any state and leaves the run alone; the
 * agent reads what it missed at its next turn, attributed, so nothing said
 * here is lost and nothing said here interrupts.
 */
export function useRoomPost(sessionId: string | null, spaceId: string | null) {
  const [isPosting, setIsPosting] = useState(false);

  const { mutateAsync } = useApiMutation<PostRoomMessageBody, PostRoomMessageResult>({
    path: `/sessions/${sessionId ?? ''}/messages`,
    method: 'POST',
    ...(spaceId ? { spaceId } : {}),
  });

  const post = useCallback(
    async (body: string, clientMessageId: string, wake = false): Promise<boolean> => {
      if (!sessionId || !body.trim()) return false;
      setIsPosting(true);
      try {
        await mutateAsync({ body, clientMessageId, ...(wake ? { wake } : {}) });
        return true;
      } finally {
        setIsPosting(false);
      }
    },
    [mutateAsync, sessionId],
  );

  return { post, isPosting };
}
