import type { ClientMsg } from '../../shared/protocol';
import type { MaintenanceActions } from './maintenance';
import { openAgentChat, onAgentChatSent } from './agent-chat-modal';
export { maintenanceContent, marqueeTitle } from './maintenance-content';
export const onMaintenanceChatSent = onAgentChatSent;

/** 3D host for the same workspace used by the Maintenance tab. */
export function openMaintenanceChat(send: (message: ClientMsg) => void, actions: MaintenanceActions, _reviewStack: () => void, initial = '', startNew = false) {
  return openAgentChat('maintenance', send, actions, initial, startNew);
}
