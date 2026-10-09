import type { ComponentType } from 'react';
import { AgentsView } from './agents.tsx';
import { ArtifactsView } from './artifacts.tsx';
import { InboxView } from './inbox.tsx';
import { JobsView } from './jobs.tsx';
import { ProjectsView } from './projects.tsx';
import { ResourcesView } from './resources.tsx';
import { SettingsView } from './settings.tsx';

export interface ViewProps {
  route: string[];
}

export const views: Record<string, ComponentType<ViewProps>> = {
  inbox: InboxView,
  jobs: JobsView,
  agents: AgentsView,
  projects: ProjectsView,
  artifacts: ArtifactsView,
  resources: ResourcesView,
  settings: SettingsView,
};
