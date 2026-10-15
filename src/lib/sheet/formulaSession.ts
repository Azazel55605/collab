import type {
  SheetFormulaEvaluationRequest,
  SheetFormulaEvaluationResponse,
} from '../../types/sheetFormula';

export type EvaluateSheetFormula = (
  request: SheetFormulaEvaluationRequest,
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

  constructor(
    private readonly evaluate: EvaluateSheetFormula,
    private readonly release: ReleaseSheetFormula,
  ) {}

  submit(request: SheetFormulaEvaluationRequest): Promise<SheetFormulaEvaluationResponse | null> {
    if (this.disposed) return Promise.resolve(null);
    this.cancelPending();
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
    this.cancelPending();
    // An invoke can still be waiting in native spawn_blocking. Its response must
    // settle before release, otherwise that queued evaluation can recreate the runtime.
    this.closing = (this.active ?? Promise.resolve()).then(() =>
      this.used ? this.release(this.runtimeId) : undefined,
    );
    return this.closing;
  }

  private drain() {
    if (this.disposed || this.active || !this.pending) return;
    const job = this.pending;
    this.pending = null;
    this.active = Promise.resolve()
      .then(() => {
        if (this.disposed) return null;
        this.used = true;
        return this.evaluate({
          ...job.request,
          runtimeId: this.runtimeId,
          // Queued work can cross a clock/day boundary. Bind volatile values at dispatch.
          evaluationTime: new Date().toISOString(),
        });
      })
      .then(job.resolve, job.reject)
      .finally(() => {
        this.active = null;
        this.drain();
      });
  }
}
