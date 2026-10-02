import type { ResolvedTextBody } from '../../../../src/lib/deck/resolve';

/** Speaker notes as readable text: paragraphs, list labels, bold, italic, underline. */
export function DeckNotes({ body }: { body: ResolvedTextBody | null }) {
  const hasText = body?.paragraphs.some((paragraph) =>
    paragraph.runs.some((run) => run.kind === 'text' && run.text.trim()),
  );
  if (!body || !hasText) {
    return <p className="deck-notes-empty">No speaker notes for this slide.</p>;
  }
  return (
    <div className="deck-notes-text">
      {body.paragraphs.map((paragraph) => (
        <p key={paragraph.id} style={{ paddingLeft: `${paragraph.level * 1.25}em` }}>
          {paragraph.label && <span className="deck-notes-label">{paragraph.label}</span>}
          {paragraph.runs.map((run, index) =>
            run.kind === 'break' ? (
              <br key={index} />
            ) : (
              <span
                key={index}
                style={{
                  fontWeight: run.style.bold ? 700 : undefined,
                  fontStyle: run.style.italic ? 'italic' : undefined,
                  textDecoration:
                    [run.style.underline ? 'underline' : '', run.style.strike ? 'line-through' : '']
                      .filter(Boolean)
                      .join(' ') || undefined,
                }}
              >
                {run.text}
              </span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}
