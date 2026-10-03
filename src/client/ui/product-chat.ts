import type { ClientMsg, WorkerInfo } from '../../shared/protocol';
import { PRODUCT_DESK } from '../../shared/layout';
import { openAgentChat, onAgentChatSent } from './agent-chat-modal';
export const onProductChatSent = onAgentChatSent;

/** 3D host for the same workspace used by the Product Lead tab. */
export function openProductChat(send: (message: ClientMsg) => void, watch: (worker: WorkerInfo) => void, startNew = false) {
  return openAgentChat('product', send, { watch, correct: () => {} }, '', startNew);
}
export const isProductLead = (w: Pick<WorkerInfo, 'deskId'>) => w.deskId === PRODUCT_DESK;
