import { History, MessageSquare, Users } from 'lucide-react';

import { useCollabStore } from '../../store/collabStore';
import { type CollabTab, useUiStore } from '../../store/uiStore';
import { sidebarSwitchListClass, sidebarSwitchTriggerClass } from '../layout/sidebarSwitch';
import { Button } from '../ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

import { HistoryPanel } from './history/HistoryPanel';
import { PeerList } from './presence/PeerList';

const ONLINE_MS = 30_000;

export function CollabPanel() {
  const collabTab = useUiStore((state) => state.collabTab);
  const setCollabTab = useUiStore((state) => state.setCollabTab);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const myUserId = useCollabStore((state) => state.myUserId);
  const peers = useCollabStore((state) => state.peers);
  const now = Date.now();
  const onlineCount = peers.filter(
    (peer) => peer.userId !== myUserId && now - peer.lastSeen < ONLINE_MS,
  ).length;
  const selectedTab = collabTab === 'chat' ? 'peers' : collabTab;
  return (
    <Tabs
      value={selectedTab}
      onValueChange={(value) => setCollabTab(value as CollabTab)}
      className="flex h-full min-h-0 flex-col gap-0 overflow-hidden"
    >
      <div className="shrink-0 px-2.5 pt-2.5 pb-2">
        <TabsList className={sidebarSwitchListClass} aria-label="Collaboration">
          <TabsTrigger value="peers" className={sidebarSwitchTriggerClass}>
            <Users />
            People
            {onlineCount > 0 && (
              <span className="text-[11px] font-medium text-green-600 dark:text-green-400">
                {onlineCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="history" className={sidebarSwitchTriggerClass}>
            <History />
            History
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="peers" className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PeerList />
        </div>
        <div className="shrink-0 border-t border-sidebar-border/60 p-2.5">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-center"
            onClick={() => setActiveView('chats')}
          >
            <MessageSquare />
            Open team chat
          </Button>
        </div>
      </TabsContent>
      <TabsContent value="history" className="min-h-0 flex-1 overflow-hidden">
        <HistoryPanel />
      </TabsContent>
    </Tabs>
  );
}
