'use client';

import { useState, type DragEvent, type HTMLAttributes, type KeyboardEvent } from 'react';

/** Which side of an item a dragged one lands on. */
export type DropSide = 'before' | 'after';

/** An item in a list the user reorders. */
export interface DragReorderItem {
  id: string;
  /** The item Alt+ArrowUp moves it before, when there is one. */
  previousId?: string | undefined;
  /** The item Alt+ArrowDown moves it after, when there is one. */
  nextId?: string | undefined;
  /** Whether the item being dragged may land beside this one. Every item, when omitted. */
  accepts?: ((draggedId: string) => boolean) | undefined;
}

/** A move the user asked for: an item placed directly before or after another. */
export interface DragReorderMove {
  id: string;
  anchor: { before: string } | { after: string };
}

/** What an item spreads to be dragged, to take a drop, and to move from the keyboard. */
export type DragReorderItemProps = HTMLAttributes<HTMLElement> & {
  draggable: boolean;
  'data-dragging'?: 'true';
};

/**
 * Reordering a list by native drag and drop. Dragged onto an item that
 * accepts it, an item lands before or after it by which half the pointer is
 * over. From the keyboard, Alt+ArrowUp and Alt+ArrowDown move the focused item
 * past its neighbour, so reordering never depends on a pointer. A drop beside
 * the neighbour an item already has moves nothing and is not reported.
 * Native drag has no touch support, so on touch the keyboard path is the one.
 */
export function useDragReorder(
  onMove: (move: DragReorderMove) => void,
  options: { disabled?: boolean } = {},
): {
  itemProps: (item: DragReorderItem) => DragReorderItemProps;
  dropSide: (id: string) => DropSide | undefined;
} {
  const disabled = options.disabled ?? false;
  const [dragged, setDragged] = useState<DragReorderItem | null>(null);
  const [over, setOver] = useState<{ id: string; side: DropSide } | null>(null);

  const sideOf = (event: DragEvent<HTMLElement>): DropSide => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2 ? 'before' : 'after';
  };
  const movesNothing = (from: DragReorderItem, target: string, side: DropSide) =>
    side === 'after' ? from.previousId === target : from.nextId === target;
  const end = () => {
    setDragged(null);
    setOver(null);
  };

  return {
    itemProps: (item) => ({
      draggable: !disabled,
      'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown',
      ...(dragged?.id === item.id ? { 'data-dragging': 'true' as const } : {}),
      onDragStart: (event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', item.id);
        setDragged(item);
      },
      onDragOver: (event) => {
        if (dragged === null || dragged.id === item.id) return;
        if (item.accepts !== undefined && !item.accepts(dragged.id)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const side = sideOf(event);
        if (over?.id !== item.id || over.side !== side) setOver({ id: item.id, side });
      },
      onDragLeave: (event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        if (over?.id === item.id) setOver(null);
      },
      onDrop: (event) => {
        event.preventDefault();
        const from = dragged;
        const side = sideOf(event);
        end();
        if (from === null || from.id === item.id || movesNothing(from, item.id, side)) return;
        if (item.accepts !== undefined && !item.accepts(from.id)) return;
        onMove({
          id: from.id,
          anchor: side === 'before' ? { before: item.id } : { after: item.id },
        });
      },
      onDragEnd: end,
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (!event.altKey || disabled) return;
        const anchor =
          event.key === 'ArrowUp' && item.previousId !== undefined
            ? { before: item.previousId }
            : event.key === 'ArrowDown' && item.nextId !== undefined
              ? { after: item.nextId }
              : undefined;
        if (anchor === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        onMove({ id: item.id, anchor });
      },
    }),
    dropSide: (id) => (over?.id === id ? over.side : undefined),
  };
}

/**
 * Where a dragged item will land: a line centred in the gap before or after
 * the item it is over. The item it sits in must be positioned and must not
 * clip its overflow.
 */
export function DropIndicator({ side, gap }: { side: DropSide | undefined; gap: number }) {
  if (side === undefined) return null;
  return (
    <span
      aria-hidden
      data-drop-indicator={side}
      style={{
        position: 'absolute',
        left: 'var(--space-2)',
        right: 'var(--space-2)',
        height: 2,
        [side === 'before' ? 'top' : 'bottom']: -(gap / 2) - 1,
        borderRadius: 'var(--radius-full)',
        background: 'var(--color-interactive-default)',
        pointerEvents: 'none',
      }}
    />
  );
}
