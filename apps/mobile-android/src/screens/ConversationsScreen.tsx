import { ConversationAccounts } from '../../../../src/components/conversations/ConversationAccounts';
import { pushBackDismiss } from '../lib/backStack';
import { useMobileStore } from '../state/store';

export function ConversationsScreen() {
  const statuses = useMobileStore((state) => state.statuses);
  return (
    <div className="mobile-conversations">
      <ConversationAccounts
        registerBack={pushBackDismiss}
        accounts={Object.entries(statuses).flatMap(([serverUrl, status]) =>
          status.user
            ? [
                {
                  serverUrl,
                  accountId: status.user.id,
                  label: serverUrl + ' · ' + status.user.displayName,
                  connected: status.connected,
                },
              ]
            : [],
        )}
      />
    </div>
  );
}
