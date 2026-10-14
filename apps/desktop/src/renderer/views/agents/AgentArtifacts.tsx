import { useApi, type Artifact } from '../../lib/api.ts';
import { ArtifactGrid } from '../artifacts.tsx';

export function AgentArtifacts({ agent }: { agent: string }) {
  const arts = useApi<Artifact[]>(`/api/artifacts?agent=${agent}`, (e) => e.type === 'changed' && e.entity === 'artifacts');
  if (arts.data && !arts.data.length) return <div className="text-sm text-muted">No artifacts yet.</div>;
  return <ArtifactGrid artifacts={arts.data ?? []} />;
}
