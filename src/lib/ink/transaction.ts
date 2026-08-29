/**
 * How an ink edit becomes a collaboration transaction.
 *
 * The rule this module exists to enforce: **one completed stroke is one
 * transaction**, and an unfinished stroke is not a transaction at all.
 *
 * Ink is the highest-frequency input in the app. A pen delivers samples faster
 * than the display refreshes, so appending a CRDT update per sample would push
 * hundreds of updates per second into the room, the revision log, and the
 * offline queue. Instead the local stroke renders immediately from memory, a
 * throttled preview travels through ephemeral awareness, and only the
 * finished, simplified, quantized stroke is committed — once.
 *
 * This module is transport-free. It decides *what* a transaction contains and
 * *how large* it may be; `liveJsonDocument.ts` and the Phase 6 ink session own
 * the Yjs plumbing.
 */
import { INK_LIMITS } from '../../types/ink';
import type { InkObject, InkSample, InkStroke } from '../../types/ink';

import { encodeSamples, sampleCount } from './codec';
import { splitIntoSegments } from './samples';

/**
 * Bytes one committed stroke transaction may encode to.
 *
 * A 4,096-sample stroke with every channel present is roughly 28 KiB of delta
 * arrays. 64 KiB leaves headroom for brush parameters and identity without
 * letting a single transaction become a document.
 */
export const INK_MAX_TRANSACTION_BYTES = 64 * 1024;

/**
 * Awareness preview rate and size.
 *
 * The preview exists so a peer sees a line being drawn, not so they see every
 * sample of it. 20 Hz is smooth to the eye, and 2 KiB carries a couple of
 * hundred points — past that the preview is describing a stroke that is about
 * to be committed anyway.
 */
export const INK_PREVIEW_INTERVAL_MS = 50;
export const INK_MAX_PREVIEW_BYTES = 2 * 1024;

export type InkTransactionKind =
  | 'stroke.add'
  | 'stroke.erase'
  | 'object.transform'
  | 'object.style'
  | 'object.delete'
  | 'object.group'
  | 'object.reorder'
  | 'layer.change'
  | 'page.change';

export interface InkTransaction {
  kind: InkTransactionKind;
  /** Objects written by this transaction. */
  objects: InkObject[];
  /** Object ids removed by this transaction. */
  removedObjectIds?: string[];
}

/**
 * Turns a completed stroke into the transactions that will be committed.
 *
 * Usually exactly one. A stroke that outgrew the sample or duration ceiling
 * becomes several linked segments, each its own bounded transaction, sharing a
 * `continuationId` so they select, transform, and erase as one line.
 */
export function strokeTransactions(
  strokeId: string,
  layerId: string,
  samples: InkSample[],
  brush: InkStroke['brush'],
  options: { authorId?: string; createdAt?: number } = {},
): InkTransaction[] {
  if (samples.length === 0) return [];
  const segments = splitIntoSegments(samples);
  const continued = segments.length > 1;

  return segments.map((segment, index) => {
    const stroke: InkStroke = {
      id: continued ? `${strokeId}-${index}` : strokeId,
      type: 'stroke',
      layerId,
      brush,
      samples: encodeSamples(segment),
      authorId: options.authorId,
      createdAt: options.createdAt,
    };
    if (continued) {
      stroke.continuationId = strokeId;
      stroke.continuationIndex = index;
    }
    return { kind: 'stroke.add', objects: [stroke] };
  });
}

/** Serialized size of a transaction, for the bound below. */
export function transactionBytes(transaction: InkTransaction): number {
  return JSON.stringify(transaction).length;
}

export interface InkTransactionViolation {
  reason: 'too-many-samples' | 'too-large' | 'too-many-objects';
  detail: string;
}

/**
 * Checks a transaction against the committed bounds.
 *
 * Returns the violations rather than throwing: the caller decides whether to
 * split further, reject the edit, or surface it. A silently oversized
 * transaction is the failure mode this guards — it would be accepted locally
 * and then stall or be rejected at the room.
 */
export function validateTransaction(transaction: InkTransaction): InkTransactionViolation[] {
  const violations: InkTransactionViolation[] = [];

  if (transaction.objects.length > INK_LIMITS.objectsPerPage) {
    violations.push({
      reason: 'too-many-objects',
      detail: `${transaction.objects.length} objects exceeds ${INK_LIMITS.objectsPerPage}`,
    });
  }

  for (const object of transaction.objects) {
    if (object.type !== 'stroke') continue;
    const count = sampleCount(object.samples);
    if (count > INK_LIMITS.samplesPerStroke) {
      violations.push({
        reason: 'too-many-samples',
        detail: `stroke ${object.id} has ${count} samples, limit ${INK_LIMITS.samplesPerStroke}`,
      });
    }
  }

  const bytes = transactionBytes(transaction);
  if (bytes > INK_MAX_TRANSACTION_BYTES) {
    violations.push({
      reason: 'too-large',
      detail: `${bytes} bytes exceeds ${INK_MAX_TRANSACTION_BYTES}`,
    });
  }

  return violations;
}

/** The ephemeral shape a peer sees while a stroke is still being drawn. */
export interface InkStrokePreview {
  strokeId: string;
  pageId: string;
  layerId: string;
  brush: InkStroke['brush'];
  /** Points in ink units, already thinned for the wire. */
  points: number[];
  /** Monotonic sequence so a late frame cannot overwrite a newer one. */
  sequence: number;
}

/**
 * Thins an in-progress stroke down to a preview that fits the wire budget.
 *
 * Takes every nth sample rather than the first n: a preview truncated at the
 * front shows the peer a line that stops growing, while an evenly thinned one
 * shows the whole shape at lower resolution. The final committed stroke
 * carries the full fidelity regardless.
 */
export function buildStrokePreview(
  strokeId: string,
  pageId: string,
  layerId: string,
  brush: InkStroke['brush'],
  samples: InkSample[],
  sequence: number,
  maxBytes = INK_MAX_PREVIEW_BYTES,
): InkStrokePreview {
  // Two coordinates per point, ~6 bytes per coordinate including separators.
  const affordablePoints = Math.max(2, Math.floor(maxBytes / 12));
  const step = Math.max(1, Math.ceil(samples.length / affordablePoints));

  const points: number[] = [];
  for (let index = 0; index < samples.length; index += step) {
    points.push(samples[index].x, samples[index].y);
  }
  const last = samples[samples.length - 1];
  // Always include the live end of the line, or the preview trails the pen.
  if (last && (points[points.length - 2] !== last.x || points[points.length - 1] !== last.y)) {
    points.push(last.x, last.y);
  }

  return { strokeId, pageId, layerId, brush, points, sequence };
}
