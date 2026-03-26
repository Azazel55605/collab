import { Layout } from 'lucide-react';

// Canvas view — full implementation coming soon
export default function CanvasPage({ relativePath }: { relativePath: string | null }) {
  return (
    <div className="flex flex-col h-full items-center justify-center text-muted-foreground gap-3 select-none">
      <Layout size={40} className="opacity-30" />
      <p className="text-lg font-medium">Canvas</p>
      <p className="text-sm opacity-60">
        {relativePath ? `${relativePath}` : 'Drag notes onto an infinite canvas to build visual overviews.'}
      </p>
    </div>
  );
}
