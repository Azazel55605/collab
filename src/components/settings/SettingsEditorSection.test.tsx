import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SettingsEditorSection from './SettingsEditorSection';

describe('SettingsEditorSection', () => {
  it('handles font and indentation controls', () => {
    const setEditorFont = vi.fn();
    const setEditorFontSize = vi.fn();
    const setIndentStyle = vi.fn();
    const setTabWidth = vi.fn();
    const setShowIndentMarkers = vi.fn();
    const setShowColoredIndents = vi.fn();

    render(
      <SettingsEditorSection
        editorFont="codingMono"
        setEditorFont={setEditorFont}
        editorFontSize={14}
        setEditorFontSize={setEditorFontSize}
        indentStyle="spaces"
        setIndentStyle={setIndentStyle}
        tabWidth={2}
        setTabWidth={setTabWidth}
        showIndentMarkers={false}
        setShowIndentMarkers={setShowIndentMarkers}
        showColoredIndents={false}
        setShowColoredIndents={setShowColoredIndents}
        showInlineColorPreviews={false}
        setShowInlineColorPreviews={vi.fn()}
        colorPreviewShowSwatch={false}
        setColorPreviewShowSwatch={vi.fn()}
        colorPreviewTintText={false}
        setColorPreviewTintText={vi.fn()}
        colorPreviewFormats={{ hex: true, rgb: false, hsl: false, oklab: false, oklch: false }}
        setColorPreviewFormatEnabled={vi.fn()}
        showColorPreviewFormats={false}
        setShowColorPreviewFormats={vi.fn()}
        spellcheckEnabled={true}
        setSpellcheckEnabled={vi.fn()}
        spellcheckLanguage="en"
        setSpellcheckLanguage={vi.fn()}
        respectNoteSpellcheckLanguage={true}
        setRespectNoteSpellcheckLanguage={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /jetbrains mono/i }));
    expect(setEditorFont).toHaveBeenCalledWith('jetbrainsMono');

    fireEvent.click(screen.getByRole('button', { name: '16px' }));
    expect(setEditorFontSize).toHaveBeenCalledWith(16);

    fireEvent.click(screen.getByRole('button', { name: 'Tabs' }));
    expect(setIndentStyle).toHaveBeenCalledWith('tabs');

    fireEvent.click(screen.getByRole('button', { name: '4' }));
    expect(setTabWidth).toHaveBeenCalledWith(4);

    fireEvent.click(screen.getAllByRole('switch')[0]);
    expect(setShowIndentMarkers).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getAllByRole('switch')[1]);
    expect(setShowColoredIndents).toHaveBeenCalledWith(true);
  });

  it('handles inline color preview controls', () => {
    const setShowInlineColorPreviews = vi.fn();
    const setColorPreviewShowSwatch = vi.fn();
    const setColorPreviewTintText = vi.fn();
    const setColorPreviewFormatEnabled = vi.fn();
    const setShowColorPreviewFormats = vi.fn();

    render(
      <SettingsEditorSection
        editorFont="codingMono"
        setEditorFont={vi.fn()}
        editorFontSize={14}
        setEditorFontSize={vi.fn()}
        indentStyle="spaces"
        setIndentStyle={vi.fn()}
        tabWidth={2}
        setTabWidth={vi.fn()}
        showIndentMarkers={false}
        setShowIndentMarkers={vi.fn()}
        showColoredIndents={false}
        setShowColoredIndents={vi.fn()}
        showInlineColorPreviews={true}
        setShowInlineColorPreviews={setShowInlineColorPreviews}
        colorPreviewShowSwatch={true}
        setColorPreviewShowSwatch={setColorPreviewShowSwatch}
        colorPreviewTintText={false}
        setColorPreviewTintText={setColorPreviewTintText}
        colorPreviewFormats={{ hex: true, rgb: false, hsl: false, oklab: false, oklch: false }}
        setColorPreviewFormatEnabled={setColorPreviewFormatEnabled}
        showColorPreviewFormats={true}
        setShowColorPreviewFormats={setShowColorPreviewFormats}
        spellcheckEnabled={true}
        setSpellcheckEnabled={vi.fn()}
        spellcheckLanguage="en"
        setSpellcheckLanguage={vi.fn()}
        respectNoteSpellcheckLanguage={true}
        setRespectNoteSpellcheckLanguage={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole('switch')[2]);
    expect(setShowInlineColorPreviews).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getAllByRole('switch')[3]);
    expect(setColorPreviewShowSwatch).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getAllByRole('switch')[4]);
    expect(setColorPreviewTintText).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: /matching formats/i }));
    expect(setShowColorPreviewFormats).toHaveBeenCalled();

    fireEvent.click(screen.getByText('RGB / RGBA'));
    expect(setColorPreviewFormatEnabled).toHaveBeenCalledWith('rgb', true);
  });

  it('handles spellcheck controls', () => {
    const setSpellcheckEnabled = vi.fn();
    const setSpellcheckLanguage = vi.fn();
    const setRespectNoteSpellcheckLanguage = vi.fn();

    render(
      <SettingsEditorSection
        editorFont="codingMono"
        setEditorFont={vi.fn()}
        editorFontSize={14}
        setEditorFontSize={vi.fn()}
        indentStyle="spaces"
        setIndentStyle={vi.fn()}
        tabWidth={2}
        setTabWidth={vi.fn()}
        showIndentMarkers={false}
        setShowIndentMarkers={vi.fn()}
        showColoredIndents={false}
        setShowColoredIndents={vi.fn()}
        showInlineColorPreviews={true}
        setShowInlineColorPreviews={vi.fn()}
        colorPreviewShowSwatch={true}
        setColorPreviewShowSwatch={vi.fn()}
        colorPreviewTintText={false}
        setColorPreviewTintText={vi.fn()}
        colorPreviewFormats={{ hex: true, rgb: false, hsl: false, oklab: false, oklch: false }}
        setColorPreviewFormatEnabled={vi.fn()}
        showColorPreviewFormats={false}
        setShowColorPreviewFormats={vi.fn()}
        spellcheckEnabled={true}
        setSpellcheckEnabled={setSpellcheckEnabled}
        spellcheckLanguage="en"
        setSpellcheckLanguage={setSpellcheckLanguage}
        respectNoteSpellcheckLanguage={true}
        setRespectNoteSpellcheckLanguage={setRespectNoteSpellcheckLanguage}
      />,
    );

    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[switches.length - 2]);
    expect(setSpellcheckEnabled).toHaveBeenCalledWith(false);

    fireEvent.change(screen.getByPlaceholderText('en'), { target: { value: 'de' } });
    expect(setSpellcheckLanguage).toHaveBeenCalledWith('de');

    fireEvent.click(switches[switches.length - 1]);
    expect(setRespectNoteSpellcheckLanguage).toHaveBeenCalledWith(false);
  });
});
