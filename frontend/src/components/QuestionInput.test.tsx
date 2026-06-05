import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QuestionInput } from "./QuestionInput";

describe("QuestionInput", () => {
  it("submits the trimmed homework question", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<QuestionInput onSubmit={onSubmit} disabled={false} />);

    await user.type(
      screen.getByPlaceholderText(/Type your homework question/),
      "  What is 6 x 7?  ",
    );
    await user.click(screen.getByRole("button", { name: /Ask the tutor/ }));

    expect(onSubmit).toHaveBeenCalledWith("What is 6 x 7?", []);
  });

  it("does not submit an empty question", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<QuestionInput onSubmit={onSubmit} disabled={false} />);

    expect(screen.getByRole("button", { name: /Ask the tutor/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Ask the tutor/ }));

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
