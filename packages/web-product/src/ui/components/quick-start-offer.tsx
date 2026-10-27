'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from '@aflow/design-system';
import { useQuickStartOffer } from '../hooks/use-quick-starts.js';
import { QuickStartPicker } from './quick-start-picker.js';

const DECLINED_KEY = 'aflow:quick-start-offer-declined';

/**
 * The first-run offer (Plan 330 D1): while the operator holds only the first
 * space and it holds nothing, each quick start is shown beside that empty
 * space. Choosing one makes a new space and leaves the empty one as it was;
 * keeping the empty space is remembered in this browser so the offer does not
 * return on every page.
 *
 * Mounted by an application that has a first run of this kind — the local
 * edition, whose instance starts with one space already made.
 */
export function QuickStartOffer() {
  const offer = useQuickStartOffer();
  const [declined, setDeclined] = useState(true);

  useEffect(() => {
    setDeclined(window.localStorage.getItem(DECLINED_KEY) === '1');
  }, []);

  const data = offer.data;
  if (declined || !data?.applies || !data.emptySpace) return null;
  const emptySpace = data.emptySpace;
  const decline = () => {
    window.localStorage.setItem(DECLINED_KEY, '1');
    setDeclined(true);
  };

  return createPortal(
    <div style={{ position: 'relative', zIndex: 10001 }}>
      <Dialog open onClose={decline} title="Start from a quick start" width="lg">
        <QuickStartPicker emptySpace={emptySpace} onKeepEmptySpace={decline} onCreated={decline} />
      </Dialog>
    </div>,
    document.body,
  );
}
