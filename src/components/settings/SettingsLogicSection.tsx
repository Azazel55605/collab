import type { SchematicSymbolSet } from '../../types/logicDiagram';
import { SCHEMATIC_SYMBOL_SETS, schematicSymbolMarkup } from '../logic/schematicSymbols';

import { OptionRow, PillSelect, SectionLabel } from './settingsControls';

type Props = {
  schematicSymbolSet: SchematicSymbolSet;
  setSchematicSymbolSet: (symbolSet: SchematicSymbolSet) => void;
};

const SYMBOL_SET_OPTIONS = Object.keys(SCHEMATIC_SYMBOL_SETS) as SchematicSymbolSet[];

export default function SettingsLogicSection({ schematicSymbolSet, setSchematicSymbolSet }: Props) {
  const selected = SCHEMATIC_SYMBOL_SETS[schematicSymbolSet];

  return (
    <div>
      <SectionLabel>Schematic notation</SectionLabel>
      <OptionRow
        label="Electrical symbol standard"
        description="Choose how circuit components are drawn without changing document data or simulation behavior"
      >
        <PillSelect
          options={SYMBOL_SET_OPTIONS}
          value={schematicSymbolSet}
          onChange={setSchematicSymbolSet}
          getLabel={(value) => (value === 'ansi' ? 'ANSI' : 'IEC / DIN')}
        />
      </OptionRow>

      <div className="mt-4 rounded-md border border-border/50 bg-card/45 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-foreground">{selected.label}</div>
            <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
              {selected.description}
            </p>
          </div>
          <svg
            viewBox="0 0 220 72"
            className="h-[72px] w-[220px] shrink-0 text-foreground"
            role="img"
            aria-label={`${selected.label} resistor and NPN transistor preview`}
          >
            <g
              dangerouslySetInnerHTML={{
                __html: schematicSymbolMarkup('resistor', 'currentColor', schematicSymbolSet),
              }}
            />
            <g
              transform="translate(120 0)"
              dangerouslySetInnerHTML={{
                __html: schematicSymbolMarkup('transistor', 'currentColor', schematicSymbolSet),
              }}
            />
          </svg>
        </div>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        This preference applies to the logic viewer and new SVG exports. Terminal names, wiring, and
        saved `.logic` files remain unchanged.
      </p>
    </div>
  );
}
