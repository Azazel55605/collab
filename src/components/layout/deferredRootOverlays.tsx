import { useUiStore } from '../../store/uiStore';

import { DeferredModalStatus } from './DeferredModalStatus';
import { deferredView } from './deferredView';

const closeManager = () => useUiStore.getState().closeVaultManager();
export const VaultManagerModal = deferredView(() => import('../vault/VaultManagerModal'), {
  loading: <DeferredModalStatus title="Manage vaults" close={closeManager} />,
  error: <DeferredModalStatus title="Manage vaults" close={closeManager} failed />,
});
export const VaultUnlockModal = deferredView(() => import('../vault/VaultUnlockModal'));
export const LiveDebugPanel = deferredView(async () => ({
  default: (await import('../collaboration/LiveDebugPanel')).LiveDebugPanel,
}));
