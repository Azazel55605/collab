/** Identical OCR preprocessing coefficients, executed only inside the pixel worker. */
export function filterPixels(data: Uint8ClampedArray, mode: string) {
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index],
      green = data[index + 1],
      blue = data[index + 2];
    const gray = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
    if (mode === 'invert') {
      data[index] = 255 - red;
      data[index + 1] = 255 - green;
      data[index + 2] = 255 - blue;
    } else {
      const value =
        mode === 'contrast'
          ? Math.max(0, Math.min(255, (gray - 128) * 1.45 + 128))
          : mode === 'threshold'
            ? gray >= 168
              ? 255
              : 0
            : gray;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
    }
  }
}
