import { ColumnTagsPrompt } from './ColumnTagsPrompt';
import type { MoveTagsPromptState } from './useCardDialogActions';

type Props = {
  draftTitle: string;
  prompt: MoveTagsPromptState | null;
  onClose: () => void;
  onApplyOnce: () => void;
  onAlwaysApply: () => void;
};

export function CardDialogMoveTagsPrompt({
  draftTitle,
  prompt,
  onClose,
  onApplyOnce,
  onAlwaysApply,
}: Props) {
  if (!prompt) return null;
  return (
    <ColumnTagsPrompt
      open
      cardTitle={draftTitle}
      columnTitle={prompt.destinationColumnTitle}
      tags={prompt.missingTags}
      onClose={onClose}
      onApplyOnce={onApplyOnce}
      onAlwaysApply={onAlwaysApply}
    />
  );
}
