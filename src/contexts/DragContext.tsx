import { createContext, useContext, useState, type ReactNode } from 'react';

export interface DraggingTabInfo {
  relativePath: string;
  title: string;
  type: string;
}

interface DragContextValue {
  draggingTab: DraggingTabInfo | null;
  setDraggingTab: (tab: DraggingTabInfo | null) => void;
}

const DragContext = createContext<DragContextValue>({
  draggingTab: null,
  setDraggingTab: () => {},
});

export function DragProvider({ children }: { children: ReactNode }) {
  const [draggingTab, setDraggingTab] = useState<DraggingTabInfo | null>(null);
  return (
    <DragContext.Provider value={{ draggingTab, setDraggingTab }}>
      {children}
    </DragContext.Provider>
  );
}

export const useDragContext = () => useContext(DragContext);
