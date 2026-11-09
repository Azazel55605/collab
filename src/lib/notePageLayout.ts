export type NotePageSettings = {
  paper: 'a4' | 'letter';
  orientation: 'portrait' | 'landscape';
  margins: 'normal' | 'narrow' | 'wide';
};

export const DEFAULT_NOTE_PAGE_SETTINGS: NotePageSettings = {
  paper: 'a4',
  orientation: 'portrait',
  margins: 'normal',
};

export const NOTE_PAGE_GAP = 28;
export const MM_TO_PX = 96 / 25.4;

export function notePageGeometry(settings: NotePageSettings) {
  const dimensions = settings.paper === 'letter' ? [215.9, 279.4] : [210, 297];
  const [widthMm, heightMm] =
    settings.orientation === 'landscape' ? [...dimensions].reverse() : dimensions;
  const marginMm = { narrow: 12, normal: 20, wide: 28 }[settings.margins];
  return {
    width: widthMm * MM_TO_PX,
    height: heightMm * MM_TO_PX,
    margin: marginMm * MM_TO_PX,
    contentWidth: (widthMm - 2 * marginMm) * MM_TO_PX,
    contentHeight: (heightMm - 2 * marginMm) * MM_TO_PX,
    widthMm,
    heightMm,
  };
}
