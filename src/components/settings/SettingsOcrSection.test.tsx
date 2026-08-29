import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type OcrLanguagePack, tauriCommands } from '../../lib/tauri';

import SettingsOcrSection from './SettingsOcrSection';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    listOcrLanguagePacks: vi.fn(),
    installOcrLanguagePack: vi.fn(),
    removeOcrLanguagePack: vi.fn(),
  },
}));

const packs: OcrLanguagePack[] = [
  {
    code: 'eng',
    label: 'English',
    bundled: true,
    installed: true,
    sizeBytes: null,
    sha256: null,
    installedAt: null,
    sourceUrl: 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata',
  },
  {
    code: 'deu',
    label: 'German',
    bundled: false,
    installed: false,
    sizeBytes: null,
    sha256: null,
    installedAt: null,
    sourceUrl: 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/deu.traineddata',
  },
];

describe('SettingsOcrSection', () => {
  beforeEach(() => {
    vi.mocked(tauriCommands.listOcrLanguagePacks).mockResolvedValue(packs);
    vi.mocked(tauriCommands.installOcrLanguagePack).mockReset();
    vi.mocked(tauriCommands.removeOcrLanguagePack).mockReset();
  });

  it('shows trusted source information and curated packs', async () => {
    render(
      <SettingsOcrSection
        ocrLanguage="eng"
        setOcrLanguage={vi.fn()}
        ocrModelSource="official-fast"
        setOcrModelSource={vi.fn()}
        ocrRenderScale={2}
        setOcrRenderScale={vi.fn()}
        ocrPreprocessingMode="none"
        setOcrPreprocessingMode={vi.fn()}
      />,
    );

    expect(await screen.findByText('Trusted OCR language packs')).toBeTruthy();
    expect(screen.getByText('Tesseract repo').closest('a')?.getAttribute('href')).toBe(
      'https://github.com/tesseract-ocr/tessdata_fast',
    );
    expect(screen.getAllByText('English').length).toBeGreaterThan(0);
    expect(screen.getByText('German')).toBeTruthy();
  });

  it('installs a language pack through the native command', async () => {
    vi.mocked(tauriCommands.installOcrLanguagePack).mockResolvedValue({
      ...packs[1],
      installed: true,
      sizeBytes: 8_000_000,
      sha256: 'abc123',
      installedAt: '2026-06-24T10:00:00Z',
    });

    render(
      <SettingsOcrSection
        ocrLanguage="eng"
        setOcrLanguage={vi.fn()}
        ocrModelSource="official-fast"
        setOcrModelSource={vi.fn()}
        ocrRenderScale={2}
        setOcrRenderScale={vi.fn()}
        ocrPreprocessingMode="none"
        setOcrPreprocessingMode={vi.fn()}
      />,
    );

    await screen.findByText('German');
    fireEvent.click(screen.getByTitle('Install German'));

    await waitFor(() => {
      expect(tauriCommands.installOcrLanguagePack).toHaveBeenCalledWith('deu');
    });
    expect(await screen.findByTitle('Remove German')).toBeTruthy();
  });
});
