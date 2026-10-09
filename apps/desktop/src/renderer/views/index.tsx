import type { ComponentType } from 'react';
import { AgentsView } from './agents.tsx';
import { ArtifactsView } from './artifacts.tsx';
import { DashboardView } from './dashboard.tsx';
import { InboxView } from './inbox.tsx';
import { JobsView } from './jobs.tsx';
import { LibraryView } from './library.tsx';
import { ProjectsView } from './projects.tsx';
import { ResourcesView } from './resources.tsx';
import { SettingsView } from './settings.tsx';

export interface ViewProps {
  route: string[];
}

export const views: Record<string, ComponentType<ViewProps>> = {
  dashboard: DashboardView,
  inbox: InboxView,
  jobs: JobsView,
  agents: AgentsView,
  library: LibraryView,
  projects: ProjectsView,
  artifacts: ArtifactsView,
  resources: ResourcesView,
  settings: SettingsView,
};
