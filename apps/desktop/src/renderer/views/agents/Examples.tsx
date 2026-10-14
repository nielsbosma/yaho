import { LibraryBig } from 'lucide-react';
import { Card } from '../../components/ui/display.tsx';
import { useApi } from '../../lib/api.ts';
import { href } from '../../lib/router.ts';

export function Examples() {
  const examples = useApi<Array<{ name: string }>>('/api/examples');
  return (
    <a href={href('library')} className="block max-w-3xl">
      <Card className="flex items-center gap-4 p-4 transition-colors hover:border-line-strong">
        <LibraryBig className="size-6 shrink-0 text-accent" />
        <div className="min-w-0">
          <div className="font-medium">Start from an example</div>
          <div className="text-sm text-muted">
            Browse {examples.data?.length ?? 'the'} ready-made agents in the Library: what each does, what it needs, and its briefing.
          </div>
        </div>
        <span className="ml-auto shrink-0 text-sm text-accent">Open Library →</span>
      </Card>
    </a>
  );
}
