const CORNERS = ['20% 25%', '80% 25%', '20% 75%', '80% 75%'];

export function paintMediaAmbiance(source: CanvasImageSource, context?: CanvasRenderingContext2D) {
  if (!context) {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    context = canvas.getContext('2d', { willReadFrequently: true }) ?? undefined;
  }
  if (!context) return null;
  try {
    context.drawImage(source, 0, 0, 2, 2);
    const { data } = context.getImageData(0, 0, 2, 2);
    return CORNERS.map((corner, index) => {
      const offset = index * 4;
      const color = `${data[offset]} ${data[offset + 1]} ${data[offset + 2]}`;
      return `radial-gradient(ellipse at ${corner}, rgb(${color} / 0.38), transparent 68%)`;
    }).join(', ');
  } catch {
    return null;
  }
}
