import { describe, expect, it } from 'vitest';

import {
  getSchematicSymbol,
  getSchematicTerminals,
  rotateSchematicClockwise,
  SCHEMATIC_SYMBOL_CHOICES,
  SCHEMATIC_SYMBOL_SETS,
  schematicSymbolDimensions,
  schematicSymbolMarkup,
  schematicTerminalPoint,
  schematicTerminalSide,
} from './schematicSymbols';

describe('schematic symbols', () => {
  it('provides the Phase 5 static component library', () => {
    expect(SCHEMATIC_SYMBOL_CHOICES.map((symbol) => symbol.kind)).toEqual([
      'resistor',
      'capacitor',
      'inductor',
      'diode',
      'led',
      'transistor',
      'switch',
      'ground',
      'junction',
      'voltage-source',
    ]);
  });

  it('defines connectable terminals and SVG geometry', () => {
    expect(getSchematicSymbol('transistor')).toMatchObject({
      inputHandles: ['base'],
      outputHandles: ['collector', 'emitter'],
    });
    expect(getSchematicSymbol('ground')).toMatchObject({
      inputHandles: ['terminal'],
      outputHandles: [],
    });
    expect(getSchematicSymbol('junction')).toMatchObject({
      inputHandles: ['terminal'],
      outputHandles: [],
      width: 24,
      height: 24,
    });
    expect(schematicSymbolMarkup('resistor', '#fff')).toContain('stroke="#fff"');
    expect(SCHEMATIC_SYMBOL_SETS.iec.label).toContain('DIN');
    expect(schematicSymbolMarkup('resistor', '#fff', 'ansi')).toContain('L26 20');
    expect(schematicSymbolMarkup('resistor', '#fff', 'iec')).toContain('H76V44');
    expect(schematicSymbolMarkup('transistor')).toContain('M46 42L78 48');
    expect(schematicSymbolMarkup('junction')).toContain('<circle');
  });

  it('rotates symbol bounds and every terminal around the symbol geometry', () => {
    expect(schematicSymbolDimensions('resistor', 0)).toEqual({ width: 120, height: 72 });
    expect(schematicSymbolDimensions('resistor', 90)).toEqual({ width: 72, height: 120 });
    expect(getSchematicTerminals('transistor')).toEqual(['base', 'collector', 'emitter']);
    expect(schematicTerminalPoint('resistor', 'terminal-a', 0)).toEqual({ x: 0, y: 36 });
    expect(schematicTerminalPoint('resistor', 'terminal-a', 90)).toEqual({ x: 36, y: 0 });
    expect(schematicTerminalPoint('resistor', 'terminal-a', 180)).toEqual({ x: 120, y: 36 });
    expect(schematicTerminalPoint('resistor', 'terminal-a', 270)).toEqual({ x: 36, y: 120 });
    expect(schematicTerminalSide('resistor', 'terminal-a', 0)).toBe('left');
    expect(schematicTerminalSide('resistor', 'terminal-a', 90)).toBe('top');
    expect(schematicTerminalSide('resistor', 'terminal-a', 180)).toBe('right');
    expect(schematicTerminalSide('resistor', 'terminal-a', 270)).toBe('bottom');
    expect(schematicTerminalPoint('junction', 'terminal', 0)).toEqual({ x: 12, y: 12 });
    expect(rotateSchematicClockwise(0)).toBe(90);
    expect(rotateSchematicClockwise(90)).toBe(180);
    expect(rotateSchematicClockwise(180)).toBe(270);
    expect(rotateSchematicClockwise(270)).toBe(0);
  });
});
