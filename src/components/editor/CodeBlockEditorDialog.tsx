import { useEffect, useMemo, useState } from 'react';

import { FileCode2, Sparkles } from 'lucide-react';

import { Badge } from '../ui/badge';
import { FormDialog, FormField } from '../ui/form-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

import {
  CODE_BLOCK_LANGUAGE_OPTIONS,
  detectCodeLanguage,
  findLanguageOption,
  getLanguageLabel,
} from './codeBlockUtils';
import { CodeEditorSurface } from './CodeEditorSurface';

const PLAIN_TEXT_SELECT_VALUE = '__plain_text__';

interface CodeBlockEditorDialogProps {
  open: boolean;
  mode: 'insert' | 'edit';
  initialLanguage: string;
  initialCode: string;
  onOpenChange: (open: boolean) => void;
  onApply: (value: { language: string; code: string }) => void;
}

export function CodeBlockEditorDialog({
  open,
  mode,
  initialLanguage,
  initialCode,
  onOpenChange,
  onApply,
}: CodeBlockEditorDialogProps) {
  const [language, setLanguage] = useState(findLanguageOption(initialLanguage).value);
  const [code, setCode] = useState(initialCode);
  const [languageTouched, setLanguageTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    const normalized = findLanguageOption(initialLanguage).value;
    setLanguage(normalized);
    setCode(initialCode);
    setLanguageTouched(normalized.length > 0);
  }, [initialCode, initialLanguage, open]);

  const detected = useMemo(() => detectCodeLanguage(code), [code]);

  useEffect(() => {
    if (!open || languageTouched) return;
    if (!detected?.language) return;
    setLanguage(findLanguageOption(detected.language).value);
  }, [detected, languageTouched, open]);

  const applyDialog = () => {
    onApply({
      language,
      code,
    });
  };

  const currentLanguageLabel = getLanguageLabel(language);
  const detectedLabel = detected ? getLanguageLabel(detected.language) : '';
  const showDetectionHint = Boolean(
    detected &&
    detected.language &&
    findLanguageOption(detected.language).value !== findLanguageOption(language).value,
  );

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="l"
      className="h-[min(820px,calc(100vh-2rem))] sm:max-w-6xl"
      bodyClassName="gap-3"
      icon={<FileCode2 />}
      title={mode === 'edit' ? 'Edit code block' : 'Insert code block'}
      description="Choose the fence language and edit the code before it goes into the note."
      submitLabel={mode === 'edit' ? 'Update code block' : 'Insert code block'}
      onSubmit={applyDialog}
    >
      <div className="flex flex-wrap items-end gap-3">
        <FormField label="Language" className="w-60">
          <Select
            value={language || PLAIN_TEXT_SELECT_VALUE}
            onValueChange={(value) => {
              setLanguage(value === PLAIN_TEXT_SELECT_VALUE ? '' : value);
              setLanguageTouched(true);
            }}
          >
            <SelectTrigger className="w-full" aria-label="Language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CODE_BLOCK_LANGUAGE_OPTIONS.map((option) => (
                <SelectItem
                  key={option.label || 'plain-text'}
                  value={option.value || PLAIN_TEXT_SELECT_VALUE}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        {detected ? (
          <div className="flex min-h-8 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant={showDetectionHint ? 'secondary' : 'outline'} className="gap-1">
              <Sparkles size={12} />
              {showDetectionHint ? `Detected ${detectedLabel}` : `Looks like ${detectedLabel}`}
            </Badge>
            <span>
              {showDetectionHint ? `Suggestion only: ${detected.reason}` : detected.reason}
            </span>
          </div>
        ) : (
          <Badge variant="outline" className="mb-1.5">
            {currentLanguageLabel}
          </Badge>
        )}
      </div>
      <div className="min-h-[360px] flex-1 overflow-hidden rounded-[10px] border border-border/60">
        <CodeEditorSurface value={code} language={language} onChange={setCode} />
      </div>
    </FormDialog>
  );
}
