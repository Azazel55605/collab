import { useId } from 'react';

import type { NotePageSettings } from '../../lib/notePageLayout';
import { useNotePageStore } from '../../store/notePageStore';
import { Label } from '../ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

function PageOption({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label={label} size="sm" className="w-auto min-w-24">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map(([key, title]) => (
              <SelectItem key={key} value={key}>
                {title}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

export function NotePageControls() {
  const settings = useNotePageStore((state) => state.settings);
  const setSettings = useNotePageStore((state) => state.setSettings);
  return (
    <div className="flex flex-wrap items-center gap-3" aria-label="Page layout">
      <PageOption
        label="Paper"
        value={settings.paper}
        options={[
          ['a4', 'A4'],
          ['letter', 'Letter'],
        ]}
        onChange={(paper) => setSettings({ paper: paper as NotePageSettings['paper'] })}
      />
      <PageOption
        label="Orientation"
        value={settings.orientation}
        options={[
          ['portrait', 'Portrait'],
          ['landscape', 'Landscape'],
        ]}
        onChange={(orientation) =>
          setSettings({ orientation: orientation as NotePageSettings['orientation'] })
        }
      />
      <PageOption
        label="Margins"
        value={settings.margins}
        options={[
          ['narrow', 'Narrow'],
          ['normal', 'Normal'],
          ['wide', 'Wide'],
        ]}
        onChange={(margins) => setSettings({ margins: margins as NotePageSettings['margins'] })}
      />
    </div>
  );
}
