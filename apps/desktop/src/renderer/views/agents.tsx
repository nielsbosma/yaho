import { AgentDetail } from './agents/AgentDetail.tsx';
import { AgentEditor } from './agents/AgentEditor.tsx';
import { AgentList } from './agents/AgentList.tsx';
import type { ViewProps } from './index.tsx';

export { AgentEditor } from './agents/AgentEditor.tsx';
export { triggerLabel } from './agents/shared.ts';

export function AgentsView({ route }: ViewProps) {
  if (route[1] === 'new') return <AgentEditor />;
  if (route[1]) return <AgentDetail name={route[1]} tab={route[2] ?? 'overview'} sub={route[3]} />;
  return <AgentList />;
}
