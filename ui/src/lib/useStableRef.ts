import { useCallback, useRef } from "react";

/**
 * Wraps a dnd-kit `setNodeRef` callback ref so React 19 does not enter
 * an infinite `setRef` loop.  dnd-kit's internal ref callback is recreated
 * on every render which causes React 19's stricter ref-identity check to
 * loop.  This hook memoises the outer callback while still forwarding the
 * node to dnd-kit.
 */
export function useStableRef<T extends HTMLElement = HTMLElement>(
  setNodeRef: (node: T | null) => void,
) {
  const nodeRef = useRef<T | null>(null);
  const stable = useCallback(
    (node: T | null) => {
      nodeRef.current = node;
      setNodeRef(node);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setNodeRef],
  );
  return stable;
}
