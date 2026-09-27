'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useSpace } from '../providers.js';
import { useCurrentUser } from '../user-avatar.js';
import { useSpacePeople, type SpacePerson } from '../../hooks/use-space-people.js';

interface MessageAuthorContextValue {
  personFor: (userId: string | undefined) => SpacePerson | undefined;
  currentUserId: string | undefined;
}

/**
 * Resolved once for the whole transcript rather than per rendered message.
 *
 * The roster and the viewer's identity are properties of the conversation, not
 * of any one line in it, so a list of N messages asks for them once. Asking per
 * message put N observers on two shared query keys, and every notification on
 * either then re-ran N memos and re-rendered N components.
 */
const MessageAuthorContext = createContext<MessageAuthorContextValue>({
  personFor: () => undefined,
  currentUserId: undefined,
});

export function MessageAuthorProvider({ children }: { children: ReactNode }) {
  const { activeSpaceId } = useSpace();
  const personFor = useSpacePeople(activeSpaceId);
  const currentUser = useCurrentUser();
  const currentUserId = currentUser?.userId;

  const value = useMemo<MessageAuthorContextValue>(
    () => ({ personFor, currentUserId }),
    [personFor, currentUserId],
  );

  return <MessageAuthorContext.Provider value={value}>{children}</MessageAuthorContext.Provider>;
}

export function useMessageAuthor(): MessageAuthorContextValue {
  return useContext(MessageAuthorContext);
}
