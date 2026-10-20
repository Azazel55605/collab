import { Component, type ComponentType, lazy, type ReactNode, Suspense } from 'react';

class ViewLoadBoundary extends Component<
  { children: ReactNode; errorFallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      if (this.props.errorFallback) return this.props.errorFallback;
      return (
        <div
          role="alert"
          className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
        >
          <p className="text-sm text-muted-foreground">Could not open this view.</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Other views are still available. Save your work there, then reopen Collab to try again.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Share each family's module load; keep loading/failure local to the current pane. */
export function deferredView<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  options?: { loading?: ReactNode; error?: ReactNode },
) {
  const View = lazy(load);
  return function DeferredView(props: P) {
    return (
      <ViewLoadBoundary errorFallback={options?.error}>
        <Suspense
          fallback={
            options?.loading ?? (
              <div
                role="status"
                className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
              >
                Loading view…
              </div>
            )
          }
        >
          <View {...props} />
        </Suspense>
      </ViewLoadBoundary>
    );
  };
}
