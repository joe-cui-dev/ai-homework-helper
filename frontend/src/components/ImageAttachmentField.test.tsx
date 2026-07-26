import { useState, type DragEvent } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ImageAttachmentField,
  hasFilesInDataTransfer,
  type ImageAttachmentValue,
} from "./ImageAttachmentField";
import { compressImage } from "../services/api";

vi.mock("../services/api", () => ({
  compressImage: vi.fn(),
}));

function makeFile(name: string, type = "image/png", lastModified = 1) {
  const file = new File([`content-${name}`], name, { type });
  Object.defineProperty(file, "lastModified", { value: lastModified });
  return file;
}

function makeDataTransfer(files: File[]) {
  return {
    files,
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    types: ["Files"],
  };
}

function getDropArea() {
  return screen.getByTestId("image-attachment-dropzone");
}

function Controlled({
  initial = [],
  maxAttachments = 5,
  disabled = false,
}: {
  initial?: ImageAttachmentValue[];
  maxAttachments?: number;
  disabled?: boolean;
}) {
  const [attachments, setAttachments] = useState<ImageAttachmentValue[]>(initial);
  return (
    <ImageAttachmentField
      attachments={attachments}
      onChange={setAttachments}
      maxAttachments={maxAttachments}
      disabled={disabled}
      accent="brand"
      prompt="Drag and drop images"
      hint="or click to choose files"
    />
  );
}

describe("ImageAttachmentField", () => {
  beforeEach(() => {
    vi.mocked(compressImage).mockReset();
    vi.mocked(compressImage).mockImplementation((file: File) =>
      Promise.resolve(`data:image/png;base64,${file.name}`),
    );
  });

  it("activates the hidden input when the drop area is clicked", async () => {
    const user = userEvent.setup();
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click");
    render(
      <ImageAttachmentField
        attachments={[]}
        onChange={vi.fn()}
        maxAttachments={5}
        disabled={false}
        accent="brand"
        prompt="Drag and drop images"
      />,
    );

    await user.click(getDropArea());

    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("activates through native keyboard behavior", async () => {
    const user = userEvent.setup();
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click");
    render(
      <ImageAttachmentField
        attachments={[]}
        onChange={vi.fn()}
        maxAttachments={5}
        disabled={false}
        accent="brand"
        prompt="Drag and drop images"
      />,
    );

    getDropArea().focus();
    await user.keyboard("{Enter}");

    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("compresses and adds dropped image files in order", async () => {
    const onChange = vi.fn();
    render(
      <ImageAttachmentField
        attachments={[]}
        onChange={onChange}
        maxAttachments={5}
        disabled={false}
        accent="brand"
        prompt="Drag and drop images"
      />,
    );

    const files = [makeFile("a.png"), makeFile("b.png")];
    fireEvent.drop(getDropArea(), { dataTransfer: makeDataTransfer(files) });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const added = onChange.mock.calls[0][0] as ImageAttachmentValue[];
    expect(added.map((a) => a.dataUrl)).toEqual([
      "data:image/png;base64,a.png",
      "data:image/png;base64,b.png",
    ]);
  });

  it("follows the same pipeline for files selected via the hidden input", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ImageAttachmentField
        attachments={[]}
        onChange={onChange}
        maxAttachments={5}
        disabled={false}
        accent="brand"
        prompt="Drag and drop images"
      />,
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, [makeFile("a.png"), makeFile("b.png")]);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const added = onChange.mock.calls[0][0] as ImageAttachmentValue[];
    expect(added).toHaveLength(2);
  });

  it("partially succeeds on a mixed batch and reports the non-image count", async () => {
    const onChange = vi.fn();
    render(
      <ImageAttachmentField
        attachments={[]}
        onChange={onChange}
        maxAttachments={5}
        disabled={false}
        accent="brand"
        prompt="Drag and drop images"
      />,
    );

    const files = [makeFile("a.png"), makeFile("b.txt", "text/plain")];
    fireEvent.drop(getDropArea(), { dataTransfer: makeDataTransfer(files) });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const added = onChange.mock.calls[0][0] as ImageAttachmentValue[];
    expect(added).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Added 1 image; ignored 1 non-image file.",
      ),
    );
  });

  it("ignores a duplicate against an existing attachment", async () => {
    const existing: ImageAttachmentValue = {
      id: "1",
      name: "a.png",
      fingerprint: "a.png::9::1",
      dataUrl: "data:image/png;base64,existing",
    };
    const dupFile = makeFile("a.png", "image/png", 1);
    Object.defineProperty(dupFile, "size", { value: 9 });
    const onChange = vi.fn();
    render(
      <ImageAttachmentField
        attachments={[existing]}
        onChange={onChange}
        maxAttachments={5}
        disabled={false}
        accent="brand"
        prompt="Drag and drop images"
      />,
    );

    fireEvent.drop(getDropArea(), { dataTransfer: makeDataTransfer([dupFile]) });

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Ignored 1 duplicate."),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a duplicate within one incoming batch", async () => {
    const onChange = vi.fn();
    render(
      <ImageAttachmentField
        attachments={[]}
        onChange={onChange}
        maxAttachments={5}
        disabled={false}
        accent="brand"
        prompt="Drag and drop images"
      />,
    );

    const fileA = makeFile("a.png", "image/png", 1);
    Object.defineProperty(fileA, "size", { value: 9 });
    const fileACopy = makeFile("a.png", "image/png", 1);
    Object.defineProperty(fileACopy, "size", { value: 9 });

    fireEvent.drop(getDropArea(), { dataTransfer: makeDataTransfer([fileA, fileACopy]) });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const added = onChange.mock.calls[0][0] as ImageAttachmentValue[];
    expect(added).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Added 1 image; ignored 1 duplicate.",
      ),
    );
  });

  it("applies capacity after invalid and duplicate filtering", async () => {
    const existing: ImageAttachmentValue = {
      id: "1",
      name: "existing.png",
      fingerprint: "existing.png::9::1",
      dataUrl: "data:image/png;base64,existing",
    };
    const dupFile = makeFile("existing.png", "image/png", 1);
    Object.defineProperty(dupFile, "size", { value: 9 });
    const onChange = vi.fn();
    render(
      <ImageAttachmentField
        attachments={[existing]}
        onChange={onChange}
        maxAttachments={2}
        disabled={false}
        accent="brand"
        prompt="Drag and drop images"
      />,
    );

    const files = [
      makeFile("nonimage.txt", "text/plain"),
      dupFile,
      makeFile("v1.png"),
      makeFile("v2.png"),
      makeFile("v3.png"),
    ];
    fireEvent.drop(getDropArea(), { dataTransfer: makeDataTransfer(files) });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const added = onChange.mock.calls[0][0] as ImageAttachmentValue[];
    // only 1 remaining slot (max 2, 1 existing) despite 3 valid unique files
    expect(added).toHaveLength(2);
    expect(added[1].name).toBe("v1.png");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Added 1 image; ignored 1 non-image file, 1 duplicate, and 2 over the limit.",
      ),
    );
  });

  it("ignores and reports over-capacity files", async () => {
    const onChange = vi.fn();
    render(
      <ImageAttachmentField
        attachments={[]}
        onChange={onChange}
        maxAttachments={1}
        disabled={false}
        accent="brand"
        prompt="Drag and drop images"
      />,
    );

    fireEvent.drop(getDropArea(), {
      dataTransfer: makeDataTransfer([makeFile("a.png"), makeFile("b.png")]),
    });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const added = onChange.mock.calls[0][0] as ImageAttachmentValue[];
    expect(added).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Added 1 image; ignored 1 over the limit.",
      ),
    );
  });

  it("preserves successful files and reports failures on partial compressImage rejection", async () => {
    vi.mocked(compressImage).mockImplementation((file: File) =>
      file.name === "bad.png"
        ? Promise.reject(new Error("Invalid image."))
        : Promise.resolve(`data:image/png;base64,${file.name}`),
    );
    const onChange = vi.fn();
    render(
      <ImageAttachmentField
        attachments={[]}
        onChange={onChange}
        maxAttachments={5}
        disabled={false}
        accent="brand"
        prompt="Drag and drop images"
      />,
    );

    fireEvent.drop(getDropArea(), {
      dataTransfer: makeDataTransfer([makeFile("good.png"), makeFile("bad.png")]),
    });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const added = onChange.mock.calls[0][0] as ImageAttachmentValue[];
    expect(added).toHaveLength(1);
    expect(added[0].name).toBe("good.png");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Added 1 image; ignored 1 that failed to process.",
      ),
    );
  });

  it("locks the drop area and remove controls while processing, and shows batch status", async () => {
    let resolveCompress: (value: string) => void = () => {};
    vi.mocked(compressImage).mockImplementation(
      () => new Promise((resolve) => { resolveCompress = resolve; }),
    );
    const existing: ImageAttachmentValue = {
      id: "1",
      name: "existing.png",
      fingerprint: "existing.png::9::1",
      dataUrl: "data:image/png;base64,existing",
    };
    render(
      <ImageAttachmentField
        attachments={[existing]}
        onChange={vi.fn()}
        maxAttachments={5}
        disabled={false}
        accent="brand"
        prompt="Drag and drop images"
      />,
    );

    fireEvent.drop(getDropArea(), { dataTransfer: makeDataTransfer([makeFile("a.png")]) });

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Preparing 1 image…"),
    );
    expect(getDropArea()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: /Remove image 1/ })).toBeDisabled();

    resolveCompress("data:image/png;base64,a.png");
    await waitFor(() => expect(getDropArea()).toHaveAttribute("aria-disabled", "false"));
  });

  it("keeps the area visible with an explanatory disabled state when at capacity", () => {
    const full: ImageAttachmentValue[] = [
      { id: "1", name: "a.png", fingerprint: "a", dataUrl: "data:a" },
    ];
    render(
      <ImageAttachmentField
        attachments={full}
        onChange={vi.fn()}
        maxAttachments={1}
        disabled={false}
        accent="brand"
        prompt="Drag and drop images"
      />,
    );

    expect(getDropArea()).toBeVisible();
    expect(getDropArea()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/Maximum of 1 images added/)).toBeInTheDocument();
  });

  it("locks add, drop, and remove when the parent marks it disabled", async () => {
    const existing: ImageAttachmentValue = {
      id: "1",
      name: "a.png",
      fingerprint: "a",
      dataUrl: "data:a",
    };
    const onChange = vi.fn();
    render(
      <ImageAttachmentField
        attachments={[existing]}
        onChange={onChange}
        maxAttachments={5}
        disabled={true}
        accent="brand"
        prompt="Drag and drop images"
      />,
    );

    expect(getDropArea()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: /Remove image 1/ })).toBeDisabled();

    fireEvent.drop(getDropArea(), { dataTransfer: makeDataTransfer([makeFile("b.png")]) });
    await new Promise((r) => setTimeout(r, 0));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("updates the controlled value on removal and allows the fingerprint to be reused", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = makeFile("a.png", "image/png", 1);
    Object.defineProperty(file, "size", { value: 9 });
    await user.upload(input, file);
    await waitFor(() => expect(screen.getByAltText(/Attached image 1/)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /Remove image 1/ }));
    await waitFor(() => expect(screen.queryByAltText(/Attached image 1/)).not.toBeInTheDocument());

    const file2 = makeFile("a.png", "image/png", 1);
    Object.defineProperty(file2, "size", { value: 9 });
    await user.upload(input, file2);
    await waitFor(() => expect(screen.getByAltText(/Attached image 1/)).toBeInTheDocument());
  });

  it("renders the feedback line in a polite atomic live region", () => {
    render(
      <ImageAttachmentField
        attachments={[]}
        onChange={vi.fn()}
        maxAttachments={5}
        disabled={false}
        accent="brand"
        prompt="Drag and drop images"
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
  });

  it("does not add anything and prevents default when a file is dropped outside the field", () => {
    const onChange = vi.fn();
    const handleFormDragOver = vi.fn((e: DragEvent<HTMLFormElement>) => {
      if (hasFilesInDataTransfer(e.dataTransfer)) e.preventDefault();
    });
    const handleFormDrop = vi.fn((e: DragEvent<HTMLFormElement>) => {
      if (hasFilesInDataTransfer(e.dataTransfer)) e.preventDefault();
    });

    render(
      <form onDragOver={handleFormDragOver} onDrop={handleFormDrop}>
        <div data-testid="outside">outside area</div>
        <ImageAttachmentField
          attachments={[]}
          onChange={onChange}
          maxAttachments={5}
          disabled={false}
          accent="brand"
          prompt="Drag and drop images"
        />
      </form>,
    );

    const result = fireEvent.drop(screen.getByTestId("outside"), {
      dataTransfer: makeDataTransfer([makeFile("a.png")]),
    });

    expect(result).toBe(false); // dispatchEvent returns false when preventDefault() was called
    expect(onChange).not.toHaveBeenCalled();
  });
});
