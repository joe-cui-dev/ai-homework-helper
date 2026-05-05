import {
  chunkQuestionsForPacketCall,
  MAX_QUESTIONS_PER_PACKET_CALL,
} from "../coachingPacket";
import type { IdentifiedQuestion } from "../types";

const q = (id: number, sourcePage?: number): IdentifiedQuestion => ({
  id,
  text: `Q${id}`,
  usesArticle: false,
  sourcePage,
});

const img = (i: number) => `data:image/jpeg;base64,IMG${i}`;

describe("chunkQuestionsForPacketCall", () => {
  it("returns one chunk for a small same-page batch", () => {
    const chunks = chunkQuestionsForPacketCall(
      [q(1, 0), q(2, 0), q(3, 0)],
      [img(0)],
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].questions.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(chunks[0].images).toEqual([img(0)]);
  });

  it("groups by sourcePage, sending only that page's image to each chunk", () => {
    const chunks = chunkQuestionsForPacketCall(
      [q(1, 0), q(2, 1), q(3, 0), q(4, 1)],
      [img(0), img(1)],
    );
    expect(chunks).toHaveLength(2);
    const page0 = chunks.find((c) => c.images[0] === img(0))!;
    const page1 = chunks.find((c) => c.images[0] === img(1))!;
    expect(page0.questions.map((x) => x.id).sort()).toEqual([1, 3]);
    expect(page1.questions.map((x) => x.id).sort()).toEqual([2, 4]);
    expect(page0.images).toEqual([img(0)]);
    expect(page1.images).toEqual([img(1)]);
  });

  it("sub-splits a single page that exceeds the per-call cap", () => {
    const N = MAX_QUESTIONS_PER_PACKET_CALL * 2 + 3; // forces 3 sub-chunks
    const questions = Array.from({ length: N }, (_, i) => q(i + 1, 0));
    const chunks = chunkQuestionsForPacketCall(questions, [img(0)]);

    expect(chunks).toHaveLength(3);
    expect(chunks[0].questions).toHaveLength(MAX_QUESTIONS_PER_PACKET_CALL);
    expect(chunks[1].questions).toHaveLength(MAX_QUESTIONS_PER_PACKET_CALL);
    expect(chunks[2].questions).toHaveLength(3);
    // Every sub-chunk inherits the same single-page image.
    for (const c of chunks) expect(c.images).toEqual([img(0)]);

    // No question lost or duplicated.
    const allIds = chunks.flatMap((c) => c.questions.map((x) => x.id));
    expect(allIds.sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
  });

  it("falls back to all images for questions without sourcePage", () => {
    const chunks = chunkQuestionsForPacketCall(
      [q(1), q(2)],
      [img(0), img(1)],
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].images).toEqual([img(0), img(1)]);
  });

  it("handles the realistic 21-question / 3-page bug scenario", () => {
    // 7 questions per page across 3 pages — exactly the cap each.
    const questions: IdentifiedQuestion[] = [];
    for (let page = 0; page < 3; page++) {
      for (let i = 0; i < 7; i++) {
        questions.push(q(page * 7 + i + 1, page));
      }
    }
    const chunks = chunkQuestionsForPacketCall(questions, [
      img(0),
      img(1),
      img(2),
    ]);
    expect(chunks).toHaveLength(3);
    for (const c of chunks) {
      expect(c.questions).toHaveLength(7);
      expect(c.images).toHaveLength(1);
    }
  });

  it("returns no chunks when given no questions", () => {
    expect(chunkQuestionsForPacketCall([], [img(0)])).toEqual([]);
  });
});
