export type MarkerCardLayout = {
  messageId: string | null;
  x: number;
  y: number;
  visible: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
  lastAnchorX: number;
  lastAnchorY: number;
  lastLabelLeft: number;
  lastLabelTop: number;
};

const CARD_GAP = 12;
const VIEWPORT_GUTTER = 8;

// Try nearby cells in order; labels stay attached to the projected point with a leader.
const PLACEMENT_SLOTS = [
  { column: 0, row: -1 },
  { column: 1, row: 0 },
  { column: 0, row: 1 },
  { column: -1, row: 0 },
  { column: 1, row: -1 },
  { column: 1, row: 1 },
  { column: -1, row: 1 },
  { column: -1, row: -1 },
] as const;

export function createMarkerCardLayouts(count: number): MarkerCardLayout[] {
  return Array.from({ length: count }, () => ({
    messageId: null,
    x: 0,
    y: 0,
    visible: false,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    lastAnchorX: Number.NaN,
    lastAnchorY: Number.NaN,
    lastLabelLeft: Number.NaN,
    lastLabelTop: Number.NaN,
  }));
}

/** Place a bounded set of map labels without DOM measurements or per-frame allocations. */
export function placeMarkerCards(
  layouts: MarkerCardLayout[],
  count: number,
  cardWidth: number,
  cardHeight: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  for (let index = 0; index < count; index += 1) {
    const current = layouts[index];
    if (!current.visible) continue;

    const minimumLeft = VIEWPORT_GUTTER;
    const maximumLeft = Math.max(minimumLeft, viewportWidth - cardWidth - VIEWPORT_GUTTER);
    const minimumTop = VIEWPORT_GUTTER;
    const maximumTop = Math.max(minimumTop, viewportHeight - cardHeight - VIEWPORT_GUTTER);
    let bestLeft = Math.max(minimumLeft, Math.min(maximumLeft, current.x - cardWidth / 2));
    let bestTop = Math.max(minimumTop, Math.min(maximumTop, current.y - cardHeight - CARD_GAP));
    let bestOverlap = Number.POSITIVE_INFINITY;
    let bestMovement = Number.POSITIVE_INFINITY;

    for (const slot of PLACEMENT_SLOTS) {
      const desiredLeft = current.x + slot.column * (cardWidth + CARD_GAP) - cardWidth / 2;
      const desiredTop = current.y + slot.row * (cardHeight + CARD_GAP) - cardHeight / 2;
      const left = Math.max(minimumLeft, Math.min(maximumLeft, desiredLeft));
      const top = Math.max(minimumTop, Math.min(maximumTop, desiredTop));
      const right = left + cardWidth;
      const bottom = top + cardHeight;
      let overlapArea = 0;

      for (let earlier = 0; earlier < index; earlier += 1) {
        const placed = layouts[earlier];
        if (!placed.visible) continue;
        const overlapWidth = Math.min(right, placed.right) - Math.max(left, placed.left);
        const overlapHeight = Math.min(bottom, placed.bottom) - Math.max(top, placed.top);
        if (overlapWidth > 0 && overlapHeight > 0) overlapArea += overlapWidth * overlapHeight;
      }

      const movement = Math.abs(left - desiredLeft) + Math.abs(top - desiredTop);

      if (overlapArea < bestOverlap || (overlapArea === bestOverlap && movement < bestMovement)) {
        bestLeft = left;
        bestTop = top;
        bestOverlap = overlapArea;
        bestMovement = movement;
      }
      if (overlapArea === 0 && movement === 0) break;
    }

    current.left = bestLeft;
    current.top = bestTop;
    current.right = bestLeft + cardWidth;
    current.bottom = bestTop + cardHeight;
  }
}
