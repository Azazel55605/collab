import { Check, ChevronDown } from 'lucide-react';

import {
  COLOR_PREVIEW_FORMAT_OPTIONS,
  EDITOR_FONTS,
  EDITOR_FONT_SIZE_OPTIONS,
  TAB_WIDTH_OPTIONS,
  type ColorPreviewFormat,
  type EditorFont,
  type IndentStyle,
} from '../../store/uiStore';
import { cn } from '../../lib/utils';
import { Separator } from '../ui/separator';
import { OptionRow, PillSelect, SectionLabel, ToggleSwitch } from './settingsControls';

type Props = {
  editorFont: EditorFont;
  setEditorFont: (font: EditorFont) => void;
  editorFontSize: number;
  setEditorFontSize: (fontSize: typeof EDITOR_FONT_SIZE_OPTIONS[number]) => void;
  indentStyle: IndentStyle;
  setIndentStyle: (style: IndentStyle) => void;
  tabWidth: number;
  setTabWidth: (width: typeof TAB_WIDTH_OPTIONS[number]) => void;
  showIndentMarkers: boolean;
  setShowIndentMarkers: (show: boolean) => void;
  showColoredIndents: boolean;
  setShowColoredIndents: (show: boolean) => void;
  showInlineColorPreviews: boolean;
  setShowInlineColorPreviews: (show: boolean) => void;
  colorPreviewShowSwatch: boolean;
  setColorPreviewShowSwatch: (show: boolean) => void;
  colorPreviewTintText: boolean;
  setColorPreviewTintText: (show: boolean) => void;
  colorPreviewFormats: Record<ColorPreviewFormat, boolean>;
  setColorPreviewFormatEnabled: (format: ColorPreviewFormat, enabled: boolean) => void;
  showColorPreviewFormats: boolean;
  setShowColorPreviewFormats: React.Dispatch<React.SetStateAction<boolean>>;
};

export default function SettingsEditorSection({
  editorFont,
  setEditorFont,
  editorFontSize,
  setEditorFontSize,
  indentStyle,
  setIndentStyle,
  tabWidth,
  setTabWidth,
  showIndentMarkers,
  setShowIndentMarkers,
  showColoredIndents,
  setShowColoredIndents,
  showInlineColorPreviews,
  setShowInlineColorPreviews,
  colorPreviewShowSwatch,
  setColorPreviewShowSwatch,
  colorPreviewTintText,
  setColorPreviewTintText,
  colorPreviewFormats,
  setColorPreviewFormatEnabled,
  showColorPreviewFormats,
  setShowColorPreviewFormats,
}: Props) {
  return (
    <div>
      <SectionLabel>Editor Font Family</SectionLabel>
      <div className="space-y-1.5 mb-5">
        {(Object.entries(EDITOR_FONTS) as [EditorFont, typeof EDITOR_FONTS[EditorFont]][]).map(
          ([key, value]) => (
            <button
              key={key}
              onClick={() => setEditorFont(key)}
              className={cn(
                'w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-all',
                editorFont === key
                  ? 'border-primary/50 bg-primary/8'
                  : 'border-border/40 hover:border-border hover:bg-accent/30',
              )}
            >
              <div>
                <p className="text-sm font-medium">{value.label}</p>
                <p className="text-[12px] text-muted-foreground mt-0.5" style={{ fontFamily: value.css }}>
                  The quick brown fox jumps over the lazy dog
                </p>
              </div>
              {editorFont === key && <Check size={14} className="text-primary shrink-0 ml-2" />}
            </button>
          ),
        )}
      </div>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Editor Font Size</SectionLabel>
      <OptionRow label="Editor font size" description="Changes note and code editors without affecting the interface">
        <PillSelect
          options={EDITOR_FONT_SIZE_OPTIONS}
          value={editorFontSize as typeof EDITOR_FONT_SIZE_OPTIONS[number]}
          onChange={setEditorFontSize}
          getLabel={(value) => `${value}px`}
        />
      </OptionRow>

      <div
        className="mt-3 p-3 rounded-lg bg-accent/20 border border-border/30 text-muted-foreground"
        style={{ fontSize: `${editorFontSize}px`, fontFamily: EDITOR_FONTS[editorFont]?.css ?? EDITOR_FONTS.codingMono.css }}
      >
        Preview: const arrow = () =&gt; value; // editor-only typography
      </div>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Indentation</SectionLabel>
      <OptionRow
        label="Indent with"
        description="Choose whether pressing Tab inserts spaces or tab characters"
      >
        <PillSelect
          options={['spaces', 'tabs'] as const}
          value={indentStyle}
          onChange={setIndentStyle}
          getLabel={(value: IndentStyle) => value === 'spaces' ? 'Spaces' : 'Tabs'}
        />
      </OptionRow>

      <OptionRow
        label="Tab width"
        description="Controls tab stop width and the number of spaces inserted when using spaces"
      >
        <PillSelect
          options={TAB_WIDTH_OPTIONS}
          value={tabWidth as typeof TAB_WIDTH_OPTIONS[number]}
          onChange={setTabWidth}
          getLabel={(value) => `${value}`}
        />
      </OptionRow>

      <OptionRow
        label="Show indent markers"
        description="Display spaces as dots and tabs as arrows in leading indentation"
      >
        <ToggleSwitch checked={showIndentMarkers} onToggle={() => setShowIndentMarkers(!showIndentMarkers)} />
      </OptionRow>

      <OptionRow
        label="Show colored indents"
        description="Display leading indentation with colored guide bands"
      >
        <ToggleSwitch checked={showColoredIndents} onToggle={() => setShowColoredIndents(!showColoredIndents)} />
      </OptionRow>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Inline Color Previews</SectionLabel>
      <OptionRow
        label="Enable inline color previews"
        description="Preview recognized color strings directly in note text"
      >
        <ToggleSwitch checked={showInlineColorPreviews} onToggle={() => setShowInlineColorPreviews(!showInlineColorPreviews)} />
      </OptionRow>

      <OptionRow
        label="Show swatches"
        description="Render a small color block before each recognized color string"
        disabled={!showInlineColorPreviews}
      >
        <ToggleSwitch
          checked={colorPreviewShowSwatch}
          onToggle={() => setColorPreviewShowSwatch(!colorPreviewShowSwatch)}
          disabled={!showInlineColorPreviews}
        />
      </OptionRow>

      <OptionRow
        label="Tint matching text"
        description="Add a soft color background behind recognized color strings"
        disabled={!showInlineColorPreviews}
      >
        <ToggleSwitch
          checked={colorPreviewTintText}
          onToggle={() => setColorPreviewTintText(!colorPreviewTintText)}
          disabled={!showInlineColorPreviews}
        />
      </OptionRow>

      <div className="mt-3">
        <button
          type="button"
          onClick={() => setShowColorPreviewFormats((value) => !value)}
          disabled={!showInlineColorPreviews}
          className={cn(
            'w-full flex items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-all',
            showInlineColorPreviews
              ? 'border-border/40 hover:border-border hover:bg-accent/30'
              : 'cursor-not-allowed border-border/30 opacity-50',
          )}
        >
          <div>
            <p className="text-sm font-medium">Matching formats</p>
            <p className="text-[12px] text-muted-foreground mt-0.5">
              Choose which kinds of color strings should trigger previews
            </p>
          </div>
          <ChevronDown
            size={16}
            className={cn(
              'shrink-0 text-muted-foreground transition-transform duration-200',
              showColorPreviewFormats && 'rotate-180',
            )}
          />
        </button>

        {showColorPreviewFormats && (
          <div className="mt-2 space-y-1.5">
            {(Object.entries(COLOR_PREVIEW_FORMAT_OPTIONS) as [ColorPreviewFormat, typeof COLOR_PREVIEW_FORMAT_OPTIONS[ColorPreviewFormat]][]).map(([format, meta]) => (
              <button
                key={format}
                onClick={() => setColorPreviewFormatEnabled(format, !colorPreviewFormats[format])}
                disabled={!showInlineColorPreviews}
                className={cn(
                  'w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-all',
                  colorPreviewFormats[format]
                    ? 'border-primary/50 bg-primary/8'
                    : 'border-border/40 hover:border-border hover:bg-accent/30',
                  !showInlineColorPreviews && 'cursor-not-allowed opacity-50 hover:border-border/40 hover:bg-transparent',
                )}
              >
                <div>
                  <p className="text-sm font-medium">{meta.label}</p>
                  <p className="text-[12px] text-muted-foreground mt-0.5">{meta.description}</p>
                </div>
                {colorPreviewFormats[format] && <Check size={14} className="text-primary shrink-0 ml-2" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
