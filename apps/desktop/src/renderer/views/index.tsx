import type { ComponentType } from 'react';
import { Empty, PageHeader } from '../components/ui/display.tsx';

export interface ViewProps {
  route: string[];
}

const placeholder = (title: string) =>
  function Placeholder() {
    return (
      <>
        <PageHeader title={title} />
        <Empty title="Coming soon">This view is built in a later step of the plan.</Empty>
      </>
    );
  };

export const views: Record<string, ComponentType<ViewProps>> = {
  inbox: placeholder('Inbox'),
  jobs: placeholder('Running jobs'),
  agents: placeholder('Agents'),
  projects: placeholder('Projects'),
  artifacts: placeholder('Artifacts'),
  resources: placeholder('Resources'),
  settings: placeholder('Settings'),
};
