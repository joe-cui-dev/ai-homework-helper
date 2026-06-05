import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressFeed } from "./ProgressFeed";

describe("ProgressFeed", () => {
  it("shows the analyzing message", () => {
    render(
      <ProgressFeed phase="analyzing" totalQuestions={3} remaining={3} />,
    );

    expect(screen.getByText(/Reading your homework/)).toBeInTheDocument();
  });

  it("shows completed packet progress", () => {
    render(
      <ProgressFeed phase="generating" totalQuestions={5} remaining={2} />,
    );

    expect(screen.getByText(/Coaching packets 3\/5/)).toBeInTheDocument();
  });
});
