import { segmented } from '../lite/kit';

export type MaintenanceView = 'chat' | 'work' | 'review';

/** Shared navigation for the kiosk workspace and /lite. */
export function maintenanceTabs(active: MaintenanceView, pick: (view: MaintenanceView) => void, count = 0) {
  const tabs = segmented<MaintenanceView>([
    { id: 'chat', label: '💬 Chat' },
    { id: 'work', label: '📌 Work' },
    { id: 'review', label: '🚀 Review', count },
  ], active, pick);
  tabs.setAttribute('aria-label', 'Maintenance workspace views');
  for (const [index, button] of [...tabs.querySelectorAll('button')].entries()) {
    button.dataset.tab = ['conversation', 'work', 'review'][index];
  }
  return tabs;
}
