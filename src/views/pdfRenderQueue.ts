let renderChain: Promise<void> = Promise.resolve();

export function enqueuePdfRender<T>(job: () => Promise<T>): Promise<T> {
  const next = renderChain.then(job, job);
  renderChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
