import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ResultCard } from "./ResultCard";
import type { CoachingPacket } from "../types";

const packet: CoachingPacket = {
  questionId: 1,
  tldrAnswer: "The answer is 42.",
  whyItWorks: "Because 6 x 7 equals 42.",
  childHint: "Try counting six groups of seven.",
};

describe("ResultCard", () => {
  it("shows answer details and reveals the child hint", async () => {
    const user = userEvent.setup();

    render(<ResultCard packet={packet} subject="math" yearLevel="year-4" />);

    expect(screen.getByText("The answer is 42.")).toBeInTheDocument();
    expect(screen.queryByText(/six groups/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Show hint/ }));

    expect(screen.getByText(/six groups of seven/)).toBeInTheDocument();
  });

  it("starts practice when requested", async () => {
    const user = userEvent.setup();
    const onPractise = vi.fn();

    render(
      <ResultCard
        packet={packet}
        subject="math"
        yearLevel="year-4"
        onPractise={onPractise}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Practise this with my child" }));

    expect(onPractise).toHaveBeenCalledOnce();
  });
});
