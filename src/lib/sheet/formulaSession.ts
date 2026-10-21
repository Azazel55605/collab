import type {
  SheetFormulaEvaluationRequest,
  SheetFormulaEvaluationResponse,
} from '../../types/sheetFormula';

export type EvaluateSheetFormula = (
  request: SheetFormulaEvaluationRequest,
  signal?: AbortSignal,
) => Promise<SheetFormulaEvaluationResponse>;
export type ReleaseSheetFormula = (runtimeId: string) => Promise<void>;
interface Job {
  request: SheetFormulaEvaluationRequest;
  resolve: (response: SheetFormulaEvaluationResponse | null) => void;
  reject: (error: unknown) => void;
}

/** One mounted workbook owns one runtime, one active request and one replaceable trailing request. */
export class SheetFormulaSession {
  readonly runtimeId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `sheet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private pending: Job | null = null;
  private active: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private disposed = false;
  private used = false;
  private cancellation: AbortController | null = null;
  private acknowledged: SheetFormulaEvaluationRequest | null = null;
  private revision = 0;
  private results = new Map<string, SheetFormulaEvaluationResponse['cells'][number]>();

  constructor(
    private readonly evaluate: EvaluateSheetFormula,
    private readonly release: ReleaseSheetFormula,
  ) {}

  submit(request: SheetFormulaEvaluationRequest): Promise<SheetFormulaEvaluationResponse | null> {
    if (this.disposed) return Promise.resolve(null);
    this.cancelPending();
    this.cancellation?.abort();
    return new Promise((resolve, reject) => {
      this.pending = { request, resolve, reject };
      this.drain();
    });
  }

  cancelPending() {
    this.pending?.resolve(null);
    this.pending = null;
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.cancellation?.abort();
    this.cancelPending();
    // An invoke can still be waiting in native spawn_blocking. Its response must
    // settle before release, otherwise that queued evaluation can recreate the runtime.
    this.closing = (this.active ?? Promise.resolve()).then(() =>
      this.used ? this.release(this.runtimeId) : undefined,
    );
    return this.closing;
  }

  private async dispatch(request: SheetFormulaEvaluationRequest, signal: AbortSignal) {
    const seed = {
      ...request,
      runtimeId: this.runtimeId,
      revision: ++this.revision,
      fullSeed: true,
      evaluationTime: new Date().toISOString(),
    };
    const previous = this.acknowledged;
    const incremental =
      previous &&
      previous.structureSignature === request.structureSignature &&
      previous.timeZone === request.timeZone;
    const key = (
      cell: Pick<
        SheetFormulaEvaluationRequest['cells'][number],
        'worksheetId' | 'rowId' | 'columnId'
      >,
    ) => `${cell.worksheetId}:${cell.rowId}:${cell.columnId}`;
    const before = new Map(previous?.cells.map((cell) => [key(cell), cell]));
    const after = new Set(request.cells.map(key));
    const same = (
      a: SheetFormulaEvaluationRequest['cells'][number] | undefined,
      b: SheetFormulaEvaluationRequest['cells'][number],
    ) =>
      a &&
      a.row === b.row &&
      a.column === b.column &&
      a.formula === b.formula &&
      a.valueType === b.valueType &&
      a.value === b.value;
    const input = incremental
      ? {
          ...seed,
          fullSeed: false,
          baseRevision: previous.revision,
          cells: request.cells.filter((cell) => !same(before.get(key(cell)), cell)),
          removedCells: [...before.keys()].filter((id) => !after.has(id)),
        }
      : seed;
    let response = await this.evaluate(input, signal);
    if (signal.aborted) {
      this.acknowledged = null;
      return null;
    }
    if (response.resetRequired) {
      response = await this.evaluate(seed, signal);
      if (signal.aborted) {
        this.acknowledged = null;
        return null;
      }
      if (response.resetRequired) throw new Error('Formula runtime could not recover its baseline');
    }
    if (response.fullResult !== false) this.results.clear();
    for (const id of response.removedCells ?? []) this.results.delete(id);
    for (const cell of response.cells) this.results.set(key(cell), cell);
    this.acknowledged =
      response.revision == null ? null : { ...request, revision: response.revision };
    return { ...response, cells: [...this.results.values()], fullResult: true, removedCells: [] };
  }

  private drain() {
    if (this.disposed || this.active || !this.pending) return;
    const job = this.pending;
    this.pending = null;
    this.active = Promise.resolve()
      .then(() => {
        if (this.disposed) return null;
        this.used = true;
        const cancellation = new AbortController();
        this.cancellation = cancellation;
        return this.dispatch(job.request, cancellation.signal);
      })
      .then(job.resolve, (error) => {
        if (this.cancellation?.signal.aborted) job.resolve(null);
        else {
          this.acknowledged = null;
          job.reject(error);
        }
      })
      .finally(() => {
        this.cancellation = null;
        this.active = null;
        this.drain();
      });
  }
}
