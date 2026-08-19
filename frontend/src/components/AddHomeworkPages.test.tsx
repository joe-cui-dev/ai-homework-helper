import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddHomeworkPages } from "./AddHomeworkPages";

vi.mock("./ImageAttachmentField", () => ({
  ImageAttachmentField: ({ onChange, disabled }: { onChange: (value: Array<{ id: string; name: string; fingerprint: string; dataUrl: string }>) => void; disabled: boolean }) => (
    <div>
      <button disabled={disabled} onClick={() => onChange([{ id: "a", name: "a.png", fingerprint: "a", dataUrl: "image-a" }])}>choose a</button>
      <button disabled={disabled} onClick={() => onChange([{ id: "b", name: "b.png", fingerprint: "b", dataUrl: "image-b" }])}>choose b</button>
    </div>
  ),
}));

describe("AddHomeworkPages", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reuses a submission id for Retry and rotates it when attachments change", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onAttachmentsChanged = vi.fn();
    const view = render(<AddHomeworkPages disabled={false} remainingPages={4} remainingQuestions={20} error={null} completedPageCount={1} onSubmit={onSubmit} onAttachmentsChanged={onAttachmentsChanged} />);
    await user.click(screen.getByRole("button", { name: "choose a" }));
    await user.click(screen.getByRole("button", { name: "Add pages" }));
    const firstId = onSubmit.mock.calls[0][1] as string;

    view.rerender(<AddHomeworkPages disabled={false} remainingPages={4} remainingQuestions={20} error={{ message: "Try again", retryable: true }} completedPageCount={1} onSubmit={onSubmit} onAttachmentsChanged={onAttachmentsChanged} />);
    await user.click(screen.getByRole("button", { name: "Retry adding pages" }));
    expect(onSubmit.mock.calls[1][1]).toBe(firstId);

    await user.click(screen.getByRole("button", { name: "choose b" }));
    await user.click(screen.getByRole("button", { name: "Retry adding pages" }));
    expect(onSubmit.mock.calls[2][1]).not.toBe(firstId);
  });

  it("explains both hard limits", () => {
    const { rerender } = render(<AddHomeworkPages disabled={false} remainingPages={0} remainingQuestions={1} error={null} completedPageCount={10} onSubmit={vi.fn()} onAttachmentsChanged={vi.fn()} />);
    expect(screen.getByText(/10-page limit/)).toBeInTheDocument();
    rerender(<AddHomeworkPages disabled={false} remainingPages={1} remainingQuestions={0} error={null} completedPageCount={1} onSubmit={vi.fn()} onAttachmentsChanged={vi.fn()} />);
    expect(screen.getByText(/30-question limit/)).toBeInTheDocument();
  });

  it("requires changing attachments before a permanent append error can be submitted again", async () => {
    const user = userEvent.setup();
    const onAttachmentsChanged = vi.fn();
    const view = render(<AddHomeworkPages disabled={false} remainingPages={4} remainingQuestions={20} error={null} completedPageCount={1} onSubmit={vi.fn()} onAttachmentsChanged={onAttachmentsChanged} />);
    await user.click(screen.getByRole("button", { name: "choose a" }));
    view.rerender(<AddHomeworkPages disabled={false} remainingPages={4} remainingQuestions={20} error={{ message: "Pages do not match", code: "validation", retryable: false }} completedPageCount={1} onSubmit={vi.fn()} onAttachmentsChanged={onAttachmentsChanged} />);
    expect(screen.getByText(/make a correction/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add pages" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Retry adding pages" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "choose b" }));
    expect(screen.getByRole("button", { name: "Add pages" })).toBeEnabled();
  });
});
