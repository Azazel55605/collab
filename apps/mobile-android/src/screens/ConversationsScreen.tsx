import { ConversationAccounts } from '../../../../src/components/conversations/ConversationAccounts';
import { pushBackDismiss } from '../lib/backStack';
import { useMobileStore } from '../state/store';

export function ConversationsScreen() {
  const statuses = useMobileStore((state) => state.statuses);
  const setTab = useMobileStore((state) => state.setTab);
  return (
    <div className="mobile-conversations">
      <ConversationAccounts
        registerBack={pushBackDismiss}
        openAccountSettings={() => setTab('settings')}
        accounts={Object.entries(statuses).flatMap(([serverUrl, status]) =>
          status.user
            ? [
                {
                  serverUrl,
                  accountId: status.user.id,
                  displayName: status.user.displayName || status.user.username,
                  username: status.user.username,
                  hasAvatar: status.user.hasAvatar,
                  avatarUpdatedAt: status.user.avatarUpdatedAt,
                  label: serverUrl + ' · ' + status.user.displayName,
                  connected: status.connected,
                  serverAdmin: status.user.role === 'admin',
                },
              ]
            : [],
        )}
      />
    </div>
  );
}
