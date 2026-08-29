import { useEffect, useMemo, useState } from 'react';

import { Check, ChevronDown, Download, ExternalLink, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { clearOcrResultCache } from '../../lib/ocrCache';
import { type OcrLanguagePack, tauriCommands } from '../../lib/tauri';
import { cn } from '../../lib/utils';
import type { OcrModelSource, OcrPreprocessingMode, OcrRenderScale } from '../../store/uiStore';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Separator } from '../ui/separator';

import { OptionRow, SectionLabel } from './settingsControls';

type Props = {
  ocrLanguage: string;
  setOcrLanguage: (language: string) => void;
  ocrModelSource: OcrModelSource;
  setOcrModelSource: (source: OcrModelSource) => void;
  ocrRenderScale: OcrRenderScale;
  setOcrRenderScale: (scale: OcrRenderScale) => void;
  ocrPreprocessingMode: OcrPreprocessingMode;
  setOcrPreprocessingMode: (mode: OcrPreprocessingMode) => void;
};

const OCR_RENDER_SCALES: OcrRenderScale[] = [1, 2, 3];
const OCR_PREPROCESSING_OPTIONS: Array<{ value: OcrPreprocessingMode; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'grayscale', label: 'Grayscale' },
  { value: 'contrast', label: 'Contrast boost' },
  { value: 'threshold', label: 'Black and white' },
  { value: 'invert', label: 'Invert colors' },
];

function formatBytes(bytes: number | null): string {
  if (bytes == null) return 'Size unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function languageOptionLabel(language: string, packs: OcrLanguagePack[]): string {
  return language
    .split('+')
    .map((code) => packs.find((pack) => pack.code === code)?.label ?? code)
    .join(' + ');
}

function buildLanguageOptions(packs: OcrLanguagePack[]): string[] {
  const installed = packs.filter((pack) => pack.installed).map((pack) => pack.code);
  const options = new Set(installed);
  if (installed.includes('eng')) {
    installed.filter((code) => code !== 'eng').forEach((code) => options.add(`eng+${code}`));
  }
  return Array.from(options);
}

export default function SettingsOcrSection({
  ocrLanguage,
  setOcrLanguage,
  ocrModelSource,
  setOcrModelSource,
  ocrRenderScale,
  setOcrRenderScale,
  ocrPreprocessingMode,
  setOcrPreprocessingMode,
}: Props) {
  const [packs, setPacks] = useState<OcrLanguagePack[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyCode, setBusyCode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    tauriCommands
      .listOcrLanguagePacks()
      .then((nextPacks) => {
        if (!cancelled) setPacks(nextPacks);
      })
      .catch((error) => {
        if (!cancelled) toast.error(`Could not load OCR language packs: ${String(error)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const languageOptions = useMemo(() => buildLanguageOptions(packs), [packs]);
  const selectedAvailable = languageOptions.includes(ocrLanguage);

  useEffect(() => {
    if (!loading && languageOptions.length > 0 && !selectedAvailable) {
      setOcrLanguage(languageOptions[0]);
    }
  }, [languageOptions, loading, ocrLanguage, selectedAvailable, setOcrLanguage]);

  const updatePack = (updated: OcrLanguagePack) => {
    setPacks((current) => current.map((pack) => (pack.code === updated.code ? updated : pack)));
  };

  const installPack = async (pack: OcrLanguagePack) => {
    setBusyCode(pack.code);
    try {
      const updated = await tauriCommands.installOcrLanguagePack(pack.code);
      updatePack(updated);
      toast.success(`${pack.label} OCR pack installed`);
    } catch (error) {
      toast.error(`Could not install ${pack.label}: ${String(error)}`);
    } finally {
      setBusyCode(null);
    }
  };

  const removePack = async (pack: OcrLanguagePack) => {
    setBusyCode(pack.code);
    try {
      const updated = await tauriCommands.removeOcrLanguagePack(pack.code);
      updatePack(updated);
      if (ocrLanguage.split('+').includes(pack.code)) {
        setOcrLanguage('eng');
      }
      toast.success(`${pack.label} OCR pack removed`);
    } catch (error) {
      toast.error(`Could not remove ${pack.label}: ${String(error)}`);
    } finally {
      setBusyCode(null);
    }
  };

  const clearCache = async () => {
    try {
      await clearOcrResultCache();
      toast.success('OCR result cache cleared');
    } catch (error) {
      toast.error(`Could not clear OCR result cache: ${String(error)}`);
    }
  };

  return (
    <div>
      <SectionLabel>Recognition</SectionLabel>
      <OptionRow
        label="Preferred language"
        description="Used by OCR actions once the selected language packs are installed"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-48 justify-between gap-2 px-2.5 text-xs"
              disabled={languageOptions.length === 0}
            >
              <span className="truncate">
                {languageOptionLabel(selectedAvailable ? ocrLanguage : 'eng', packs)}
              </span>
              <ChevronDown size={14} className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>Preferred language</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={selectedAvailable ? ocrLanguage : 'eng'}
              onValueChange={setOcrLanguage}
            >
              {languageOptions.map((option) => (
                <DropdownMenuRadioItem key={option} value={option} className="text-xs">
                  {languageOptionLabel(option, packs)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </OptionRow>

      <OptionRow
        label="Model source"
        description="Fast official Tesseract models are optimized for normal interactive OCR"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-48 justify-between gap-2 px-2.5 text-xs"
            >
              <span className="truncate">Official fast</span>
              <ChevronDown size={14} className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>Model source</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={ocrModelSource}
              onValueChange={(value) => setOcrModelSource(value as OcrModelSource)}
            >
              <DropdownMenuRadioItem value="official-fast" className="text-xs">
                Official fast
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </OptionRow>

      <OptionRow
        label="PDF OCR render scale"
        description="Renders PDF pages at this internal resolution before OCR"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-48 justify-between gap-2 px-2.5 text-xs"
            >
              <span className="truncate">{ocrRenderScale}x</span>
              <ChevronDown size={14} className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>PDF OCR render scale</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={String(ocrRenderScale)}
              onValueChange={(value) => setOcrRenderScale(Number(value) as OcrRenderScale)}
            >
              {OCR_RENDER_SCALES.map((scale) => (
                <DropdownMenuRadioItem key={scale} value={String(scale)} className="text-xs">
                  {scale}x
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </OptionRow>

      <OptionRow
        label="Image preprocessing"
        description="Optional explicit retry mode. None keeps the original image unchanged."
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-48 justify-between gap-2 px-2.5 text-xs"
            >
              <span className="truncate">
                {OCR_PREPROCESSING_OPTIONS.find((option) => option.value === ocrPreprocessingMode)
                  ?.label ?? 'None'}
              </span>
              <ChevronDown size={14} className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>Image preprocessing</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={ocrPreprocessingMode}
              onValueChange={(value) => setOcrPreprocessingMode(value as OcrPreprocessingMode)}
            >
              {OCR_PREPROCESSING_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value} className="text-xs">
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </OptionRow>

      <div className="mt-3 rounded-lg border border-orange-400/25 bg-orange-400/10 p-3 text-xs text-muted-foreground">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="font-medium text-foreground">Trusted OCR language packs</span>
          <a
            href="https://github.com/tesseract-ocr/tessdata_fast"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            Tesseract repo
            <ExternalLink size={12} />
          </a>
        </div>
        OCR language packs are downloaded from the official Tesseract OCR project on GitHub. Only
        install language packs from trusted sources, because OCR models are engine data consumed by
        the recognition runtime.
      </div>

      <Separator className="my-4 bg-border/40" />

      <SectionLabel>Cache</SectionLabel>
      <OptionRow
        label="OCR result cache"
        description="Clears cached recognized and extracted text. Language packs stay installed."
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-xs"
          onClick={() => void clearCache()}
        >
          <Trash2 size={13} />
          Clear
        </Button>
      </OptionRow>

      <Separator className="my-4 bg-border/40" />

      <SectionLabel>Language Packs</SectionLabel>
      <div className="space-y-2">
        {loading && (
          <div className="flex items-center gap-2 rounded-lg border border-border/35 bg-card/45 px-3 py-3 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            Loading OCR language packs...
          </div>
        )}

        {!loading &&
          packs.map((pack) => {
            const busy = busyCode === pack.code;
            return (
              <div
                key={pack.code}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/35 bg-card/45 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{pack.label}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{pack.code}</span>
                    {pack.bundled && (
                      <Badge variant="secondary" className="h-5 text-[10px]">
                        Bundled
                      </Badge>
                    )}
                    {pack.installed && !pack.bundled && (
                      <Badge variant="outline" className="h-5 text-[10px]">
                        Installed
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span>
                      {pack.installed && !pack.bundled
                        ? formatBytes(pack.sizeBytes)
                        : pack.bundled
                          ? 'Available offline'
                          : 'Not installed'}
                    </span>
                    <a
                      href={pack.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-primary hover:underline"
                    >
                      official source
                    </a>
                    {pack.sha256 && (
                      <span className="font-mono">sha256 {pack.sha256.slice(0, 10)}...</span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {pack.installed ? (
                    pack.bundled ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 text-emerald-400"
                        disabled
                        title="Bundled"
                      >
                        <Check size={14} />
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        variant="outline"
                        className="size-8 text-destructive"
                        disabled={busy}
                        onClick={() => void removePack(pack)}
                        title={`Remove ${pack.label}`}
                      >
                        {busy ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </Button>
                    )
                  ) : (
                    <Button
                      size="icon"
                      variant="outline"
                      className={cn('size-8', busy && 'pointer-events-none')}
                      disabled={busy}
                      onClick={() => void installPack(pack)}
                      title={`Install ${pack.label}`}
                    >
                      {busy ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Download size={14} />
                      )}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
