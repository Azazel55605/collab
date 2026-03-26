import { useCollabStore } from '../../store/collabStore';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

export default function PresenceBar() {
  const { peers } = useCollabStore();
  if (peers.length === 0) return null;

  return (
    <div className="flex items-center gap-1">
      {peers.slice(0, 5).map((peer) => (
        <Tooltip key={peer.userId}>
          <TooltipTrigger>
            <div
              className="w-5 h-5 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
              style={{ backgroundColor: peer.userColor }}
            >
              {peer.userName.charAt(0).toUpperCase()}
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p>{peer.userName}</p>
            {peer.activeFile && (
              <p className="text-xs opacity-70">editing {peer.activeFile}</p>
            )}
          </TooltipContent>
        </Tooltip>
      ))}
      {peers.length > 5 && (
        <span className="text-xs text-muted-foreground">+{peers.length - 5}</span>
      )}
    </div>
  );
}
