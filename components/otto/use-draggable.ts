"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

/**
 * Drag-to-move for a single floating panel, on native Pointer Events.
 *
 * Deliberately not a library. `react-draggable` (and `react-rnd`, which wraps
 * it) call `ReactDOM.findDOMNode`, removed in React 19 — they throw on this
 * stack. `@dnd-kit` is built for sortable lists between droppable containers,
 * which is a different problem with a much larger surface. One panel needs a
 * pointer offset and a clamp, and pointer capture gives mouse, touch and pen
 * in one code path.
 *
 * The offset lives in a ref and is written straight to `style.transform`, so a
 * drag causes no React renders at all — and no state restored from storage
 * during render, which would desynchronise hydration.
 */

interface DragOffset {
  x: number;
  y: number;
}

const STORAGE_KEY = "bauai.otto.panelOffset";
/** Keep this much of the panel on screen; fully off-screen reads as gone. */
const EDGE_MARGIN = 56;

function readStored(): DragOffset | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DragOffset;
    return typeof parsed?.x === "number" && typeof parsed?.y === "number"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Offsets grow toward the top-left, because the panel is anchored bottom-right. */
function clamp(offset: DragOffset, node: HTMLElement): DragOffset {
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  return {
    x: Math.min(Math.max(offset.x, -(window.innerWidth - width - EDGE_MARGIN)), width - EDGE_MARGIN),
    y: Math.min(Math.max(offset.y, -(window.innerHeight - height - EDGE_MARGIN)), height - EDGE_MARGIN),
  };
}

export function useDraggable(enabled: boolean) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const offset = useRef<DragOffset>({ x: 0, y: 0 });
  const origin = useRef({ pointerX: 0, pointerY: 0, startX: 0, startY: 0 });
  // The only render-affecting bit: the grab/grabbing cursor.
  const [dragging, setDragging] = useState(false);

  const paint = useCallback(() => {
    const node = nodeRef.current;
    if (!node) return;
    node.style.transform = `translate3d(${-offset.current.x}px, ${-offset.current.y}px, 0)`;
  }, []);

  // Restoring position is a DOM update, which is what effects are for — as
  // opposed to setting state, which would cascade a render for no reason.
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    if (!enabled) {
      offset.current = { x: 0, y: 0 };
      paint();
      return;
    }
    const stored = readStored();
    if (stored) offset.current = clamp(stored, node);
    paint();
  }, [enabled, paint]);

  useEffect(() => {
    const onResize = () => {
      const node = nodeRef.current;
      if (!node) return;
      offset.current = clamp(offset.current, node);
      paint();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [paint]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!enabled) return;
      // Buttons in the header stay buttons.
      if ((event.target as HTMLElement).closest("button")) return;

      event.currentTarget.setPointerCapture(event.pointerId);
      origin.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        startX: offset.current.x,
        startY: offset.current.y,
      };
      setDragging(true);
    },
    [enabled],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const node = nodeRef.current;
      if (!dragging || !node) return;
      offset.current = clamp(
        {
          x: origin.current.startX - (event.clientX - origin.current.pointerX),
          y: origin.current.startY - (event.clientY - origin.current.pointerY),
        },
        node,
      );
      paint();
    },
    [dragging, paint],
  );

  const endDrag = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!dragging) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setDragging(false);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(offset.current));
      } catch {
        // Persistence is a nicety; losing it must not break the drag.
      }
    },
    [dragging],
  );

  /** Double-click the header to put the panel back in its corner. */
  const reset = useCallback(() => {
    offset.current = { x: 0, y: 0 };
    paint();
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignored
    }
  }, [paint]);

  return {
    nodeRef,
    dragging,
    reset,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}
