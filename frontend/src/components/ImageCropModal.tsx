import { useState, useCallback } from "react";
import Cropper from "react-easy-crop";
import type { Area, Point } from "react-easy-crop";

interface ImageCropModalProps {
  imageSrc: string;
  onConfirm: (croppedDataUrl: string) => void;
  onCancel: () => void;
}

type AspectOption = { label: string; value: number | undefined };

const ASPECT_OPTIONS: AspectOption[] = [
  { label: "Free", value: undefined },
  { label: "1 : 1", value: 1 },
  { label: "4 : 3", value: 4 / 3 },
  { label: "3 : 4", value: 3 / 4 },
];

async function cropImageToDataUrl(
  imageSrc: string,
  pixelCrop: Area,
): Promise<string> {
  const img = new Image();
  img.src = imageSrc;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load image for cropping"));
  });
  const canvas = document.createElement("canvas");
  canvas.width = pixelCrop.width;
  canvas.height = pixelCrop.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(
    img,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    pixelCrop.width,
    pixelCrop.height,
  );
  return canvas.toDataURL("image/jpeg", 0.9);
}

export function ImageCropModal({
  imageSrc,
  onConfirm,
  onCancel,
}: ImageCropModalProps) {
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [aspect, setAspect] = useState<number | undefined>(undefined);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [loading, setLoading] = useState(false);

  const onCropComplete = useCallback((_: Area, pixels: Area) => {
    setCroppedAreaPixels(pixels);
  }, []);

  const handleConfirm = async () => {
    if (!croppedAreaPixels) return;
    setLoading(true);
    try {
      const dataUrl = await cropImageToDataUrl(imageSrc, croppedAreaPixels);
      onConfirm(dataUrl);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-900 text-white shrink-0">
        <button
          onClick={onCancel}
          className="text-sm font-semibold text-gray-300 hover:text-white transition-colors px-2 py-1"
        >
          Cancel
        </button>
        <span className="text-sm font-bold tracking-wide">Crop photo</span>
        <button
          onClick={handleConfirm}
          disabled={loading || !croppedAreaPixels}
          className="text-sm font-bold text-brand-400 hover:text-brand-300 disabled:opacity-40 transition-colors px-2 py-1"
        >
          {loading ? "Saving…" : "Use photo"}
        </button>
      </div>

      {/* Crop area — fills remaining height */}
      <div className="relative flex-1">
        <Cropper
          image={imageSrc}
          crop={crop}
          zoom={zoom}
          aspect={aspect}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={onCropComplete}
          style={{
            containerStyle: { background: "#111" },
          }}
        />
      </div>

      {/* Controls */}
      <div className="bg-gray-900 px-4 pt-3 pb-5 space-y-3 shrink-0">
        {/* Aspect ratio selector */}
        <div className="flex items-center justify-center gap-2">
          {ASPECT_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              onClick={() => setAspect(opt.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                aspect === opt.value
                  ? "bg-brand-500 text-white"
                  : "bg-gray-700 text-gray-300 hover:bg-gray-600"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Zoom slider */}
        <div className="flex items-center gap-3">
          <span className="text-gray-400 text-xs w-6 text-center">−</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="flex-1 accent-brand-500 h-1.5 cursor-pointer"
          />
          <span className="text-gray-400 text-xs w-6 text-center">+</span>
        </div>
      </div>
    </div>
  );
}
