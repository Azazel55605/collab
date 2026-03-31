import { useState } from 'react';
import { PeerList } from './presence/PeerList';
import { ChatPanel } from './chat/ChatPanel';
import { HistoryPanel } from './history/HistoryPanel';

type Tab = 'peers' | 'chat' | 'history';

const TABS: { id: Tab; label: string }[] = [
  { id: 'peers', label: 'Peers' },
  { id: 'chat', label: 'Chat' },
  { id: 'history', label: 'History' },
];

export function CollabPanel() {
  const [activeTab, setActiveTab] = useState<Tab>('peers');

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex border-b border-border px-2 pt-1 gap-0.5 flex-shrink-0">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-1.5 text-xs rounded-t font-medium transition-colors ${
              activeTab === tab.id
                ? 'text-foreground border-b-2 border-primary -mb-px'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {activeTab === 'peers' && (
          <div className="overflow-y-auto flex-1">
            <PeerList />
          </div>
        )}
        {activeTab === 'chat' && <ChatPanel />}
        {activeTab === 'history' && (
          <div className="overflow-y-auto flex-1">
            <HistoryPanel />
          </div>
        )}
      </div>
    </div>
  );
}
