/**
 * The type ramp (ux-v2 doctrine §2): the only four font sizes a component
 * rule may declare literally. Display/title/body/label. Navigation plan E7
 * took the 11px data step out (amendment A3): nothing on the board is drawn
 * below 12px, so data reads at the label size.
 *
 * This is the single source both the doctrine table and the guard
 * (`type-ramp.test.ts`) read from — the numbers live here once.
 */
export const TYPE_RAMP_PX = [22, 16, 13, 12] as const;
