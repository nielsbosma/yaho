import type { ComponentType } from 'react';
import { Empty, PageHeader } from '../components/ui/display.tsx';
import { AgentsView } from './agents.tsx';
import { ArtifactsView } from './artifacts.tsx';
import { InboxView } from './inbox.tsx';
import { JobsView } from './jobs.tsx';

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
  inbox: InboxView,
  jobs: JobsView,
  agents: AgentsView,
  projects: placeholder('Projects'),
  artifacts: ArtifactsView,
  resources: placeholder('Resources'),
  settings: placeholder('Settings'),
};
