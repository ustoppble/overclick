import { describe, expect, it } from "vitest";
import { joinReviewQueue } from "./review-queue-order";

/**
 * The E1 review (B2): the number on the To review list is the queue's, the
 * same count the chip carries, and not however many lines happened to load.
 */
describe("the To review list's number is the queue's length (B2)", () => {
  const queue = [
    { id: "a", deliveredAt: "2026-11-01T00:00:00.000Z", checks: { done: 0, total: 1 } },
    { id: "b", deliveredAt: "2026-11-02T00:00:00.000Z", checks: { done: 1, total: 1 } },
    { id: "c", deliveredAt: "2026-11-03T00:00:00.000Z", checks: { done: 0, total: 0 } },
  ];

  it("keeps the queue's order and attaches each card", () => {
    const cards = [{ id: "c" }, { id: "a" }, { id: "b" }];
    const joined = joinReviewQueue(queue, cards);
    expect(joined.rows.map((row) => row.card.id)).toEqual(["a", "b", "c"]);
    expect(joined.count).toBe(3);
  });

  it("still says 3 when a line could not be read, and names what is missing", () => {
    const joined = joinReviewQueue(queue, [{ id: "a" }, { id: "c" }]);
    expect(joined.rows.map((row) => row.card.id)).toEqual(["a", "c"]);
    expect(joined.count).toBe(queue.length);
    expect(joined.missing).toEqual(["b"]);
  });
});
