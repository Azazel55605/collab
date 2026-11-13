import {
  Diamond,
  FileText,
  Flag,
  Globe,
  LayoutTemplate,
  PencilLine,
  Plus,
  Route,
  Shapes,
  Users,
} from 'lucide-react';

import type { PlanningCanvasNode } from '../../types/canvas';
import { FloatingBar, FloatingSeparator, RailButton, ZoomPill } from '../layout/CanvasChrome';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

import type { CanvasPlanningPreset } from './canvasPlanning';

interface CanvasToolbarProps {
  zoomLabel: string;
  onAddNote: () => void;
  onAddFile: () => void;
  onAddText: () => void;
  onAddWeb: () => void;
  onAddSymbol: () => void;
  onAddPlanningNode: (type: PlanningCanvasNode['type']) => void;
  onApplyPreset: (preset: CanvasPlanningPreset) => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onZoomIn: () => void;
  onFitView: () => void;
  /** Viewer access to a hosted vault: hide all node-adding controls. */
  readOnly?: boolean;
}

export function CanvasToolbar({
  zoomLabel,
  onAddNote,
  onAddFile,
  onAddText,
  onAddWeb,
  onAddSymbol,
  onAddPlanningNode,
  onApplyPreset,
  onZoomOut,
  onResetZoom,
  onZoomIn,
  onFitView,
  readOnly = false,
}: CanvasToolbarProps) {
  return (
    <>
      {!readOnly && (
        <FloatingBar
          role="toolbar"
          aria-label="Add to canvas"
          orientation="vertical"
          className="top-1/2 left-3 -translate-y-1/2"
        >
          <RailButton label="Add note" hint="Add a note card" onClick={onAddNote}>
            <Plus />
          </RailButton>
          <RailButton label="Add file" hint="Add a file from the vault" onClick={onAddFile}>
            <FileText />
          </RailButton>
          <RailButton label="Add text" onClick={onAddText}>
            <PencilLine />
          </RailButton>
          <RailButton label="Add web" hint="Add a web page" onClick={onAddWeb}>
            <Globe />
          </RailButton>
          <RailButton label="Add symbol" onClick={onAddSymbol}>
            <Shapes />
          </RailButton>
          <FloatingSeparator vertical />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RailButton label="Planning nodes" hint="Flow, planning and structure nodes">
                <Route />
              </RailButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" className="w-60">
              <DropdownMenuLabel>Flow</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => onAddPlanningNode('process')}>
                <Route size={14} />
                Process
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAddPlanningNode('decision')}>
                <Diamond size={14} />
                Decision
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAddPlanningNode('terminator')}>
                <Flag size={14} />
                Start / End
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAddPlanningNode('junction')}>
                <Plus size={14} />
                Junction
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAddPlanningNode('crossing')}>
                <Route size={14} />
                Crossing
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Planning</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => onAddPlanningNode('milestone')}>
                <Flag size={14} />
                Milestone
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAddPlanningNode('actor')}>
                <Users size={14} />
                Actor
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAddPlanningNode('document')}>
                <FileText size={14} />
                Document
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Structure</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => onAddPlanningNode('swimlane')}>
                <Route size={14} />
                Swimlane
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAddPlanningNode('group')}>
                <Route size={14} />
                Group
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RailButton label="Presets" hint="Start from a preset layout">
                <LayoutTemplate />
              </RailButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" className="w-56">
              <DropdownMenuLabel>Presets</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => onApplyPreset('flowchart')}>
                Flowchart
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onApplyPreset('project_workflow')}>
                Project workflow
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onApplyPreset('responsibility_lanes')}>
                Responsibility lanes
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onApplyPreset('decision_tree')}>
                Decision tree
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onApplyPreset('system_process_sketch')}>
                System/process sketch
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </FloatingBar>
      )}

      <ZoomPill
        label={zoomLabel}
        onZoomOut={onZoomOut}
        onZoomIn={onZoomIn}
        onReset={onResetZoom}
        onFit={onFitView}
      />
    </>
  );
}
