import { type CollabTab, useUiStore } from '../../store/uiStore';
import { Button } from '../ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

import { HistoryPanel } from './history/HistoryPanel';
import { PeerList } from './presence/PeerList';

export function CollabPanel() {
  const collabTab = useUiStore((state) => state.collabTab);
  const setCollabTab = useUiStore((state) => state.setCollabTab);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const selectedTab = collabTab === 'chat' ? 'peers' : collabTab;
  return (
    <Tabs
      value={selectedTab}
      onValueChange={(value) => setCollabTab(value as CollabTab)}
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
        <TabsList>
          <TabsTrigger value="peers">Peers</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <Button variant="ghost" size="sm" onClick={() => setActiveView('chats')}>
          Open chats
        </Button>
      </div>
      <TabsContent value="peers" className="min-h-0 flex-1 overflow-y-auto">
        <PeerList />
      </TabsContent>
      <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto">
        <HistoryPanel />
      </TabsContent>
    </Tabs>
  );
}
