import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ui/button', () => ({
  Button: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock('../ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock('../ui/checkbox', () => ({
  Checkbox: ({ checked, onCheckedChange }: { checked?: boolean; onCheckedChange?: (checked: boolean) => void }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}));

vi.mock('../ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) => (
    <select aria-label="select" value={value} disabled={disabled} onChange={(event) => onValueChange?.(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => <option value={value}>{children}</option>,
}));

import { CanvasEdgeInspector } from './CanvasEdgeInspector';

describe('CanvasEdgeInspector', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the empty state when no edge is selected', () => {
    render(
      <CanvasEdgeInspector
        selectedEdgeData={null}
        edgeLabelDraft=""
        onEdgeLabelChange={vi.fn()}
        onLineStyleChange={vi.fn()}
        onAnimationDirectionChange={vi.fn()}
        onAnimationChange={vi.fn()}
        onMarkerStartChange={vi.fn()}
        onMarkerEndChange={vi.fn()}
        onDeleteSelected={vi.fn()}
      />,
    );

    expect(screen.getByText(/select a line to rename or delete it/i)).toBeTruthy();
  });

  it('wires label, toggle, and delete actions for a selected edge', () => {
    const onEdgeLabelChange = vi.fn();
    const onAnimationChange = vi.fn();
    const onMarkerStartChange = vi.fn();
    const onDeleteSelected = vi.fn();

    render(
      <CanvasEdgeInspector
        selectedEdgeData={{
          label: 'Depends on',
          lineStyle: 'solid',
          animated: false,
          animationReverse: false,
          markerStart: false,
          markerEnd: true,
        }}
        edgeLabelDraft="Depends on"
        onEdgeLabelChange={onEdgeLabelChange}
        onLineStyleChange={vi.fn()}
        onAnimationDirectionChange={vi.fn()}
        onAnimationChange={onAnimationChange}
        onMarkerStartChange={onMarkerStartChange}
        onMarkerEndChange={vi.fn()}
        onDeleteSelected={onDeleteSelected}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/connection label/i), {
      target: { value: 'Blocks' },
    });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    fireEvent.click(screen.getByRole('button', { name: /delete selected/i }));

    expect(onEdgeLabelChange).toHaveBeenCalledWith('Blocks');
    expect(onAnimationChange).toHaveBeenCalledWith(true);
    expect(onMarkerStartChange).toHaveBeenCalledWith(true);
    expect(onDeleteSelected).toHaveBeenCalled();
  });
});
