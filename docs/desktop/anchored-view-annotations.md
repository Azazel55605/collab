# Anchored View Annotation Adapter

Anchored view annotations let an immutable file viewer reuse the shared ink
scene without changing the source file. Images use this contract now; deck
review has an explicit registration ready for the future presentation viewer.

## Opt-in contract

A viewer must register all three values in `src/lib/viewAnnotations.ts`:

1. an `InkAnnotationAnchor.kind` that identifies stable source coordinates;
2. a deterministic surface id for each independently annotated frame; and
3. the hosted capability required to mutate the sidecar.

Registration is deliberate. File extensions do not implicitly enable
annotations. The current registrations are `image`, `deckReview`, and
`genericFrame`; all hosted mutations require `view.annotate`.

The adapter creates or finds an `InkAnnotationSurface`, exposes it as a fixed
`InkPage` to `AnchoredInkOverlay`, and writes the changed `InkScene` back into
the annotation document. Coordinates remain in ink units while the anchor
stores the immutable source dimensions. Viewer zoom changes only the display
transform and never rewrites scene geometry.

## Persistence and conflicts

Call `VaultClient.readViewAnnotations` and
`VaultClient.writeViewAnnotations`; do not call local sidecar commands from a
viewer. Local vaults retain `.collab/image-overlays/` as the on-disk location
for compatibility. Hosted vaults use the versioned `/view-annotations`
resource, the encrypted replica document cache, and the `viewAnnotations`
pending operation for offline replay.

The source file and annotation sequence are independent. A viewer must use the
document-session controller so remote updates, optimistic conflicts, autosave,
and offline status follow the same behavior as PDF annotations.

## Source transforms and export

Annotations are anchored to the original source coordinate system. Zoom and
OCR overlays are presentation-only layers. Crop, rotate, and resize previews
must not mutate the sidecar or move its objects. Permanent source edits are a
separate raster workflow; annotated export composites the authoritative scene
at source resolution into a new copy and retains both the original source and
editable sidecar.

Deck edit mode may eventually embed ink in deck content. Deck review mode must
instead use the registered `deck-slide` anchor and one deterministic surface
per stable slide id. Temporary presenter ink remains ephemeral unless a user
explicitly commits it to the review sidecar.

## Adapter checklist

- Define stable source dimensions and frame ids.
- Add an explicit capability registry entry.
- Render through `AnchoredInkOverlay` and the shared tool state.
- Persist only through `VaultClient`.
- Keep source transforms separate from annotation geometry.
- Provide an explicit flattened-copy export if the format supports it.
- Test invalid-sidecar repair, zoom, source transforms, conflicts, and offline
  replay.
