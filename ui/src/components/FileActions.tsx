import { useState, useEffect } from "react";
import { FolderOpen, Code, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fileOpsApi, type IDE } from "../api/file-ops";
import { useToast } from "../context/ToastContext";

interface FileActionsProps {
  filePath: string;
  className?: string;
}

export function FileActions({ filePath, className }: FileActionsProps) {
  const [ides, setIdes] = useState<IDE[]>([]);
  const [loading, setLoading] = useState(false);
  const { pushToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    fileOpsApi.getAvailableIDEs().then(
      (res) => {
        if (!cancelled) setIdes(res.ides);
      },
      () => {
        // silently ignore — the buttons will still render
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpenInIDE = async (ideId?: string) => {
    setLoading(true);
    try {
      await fileOpsApi.openInIDE(filePath, ideId);
      pushToast({ title: "Opened in IDE", tone: "success" });
    } catch (err) {
      pushToast({
        title: "Failed to open in IDE",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleRevealInFinder = async () => {
    try {
      await fileOpsApi.revealInFinder(filePath);
      pushToast({ title: "Revealed in file manager", tone: "success" });
    } catch (err) {
      pushToast({
        title: "Failed to reveal in file manager",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    }
  };

  const primaryIde = ides[0];

  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ""}`}>
      {ides.length <= 1 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={loading || ides.length === 0}
              onClick={() => handleOpenInIDE(primaryIde?.id)}
              aria-label={primaryIde ? `Open in ${primaryIde.name}` : "Open in IDE"}
            >
              <Code className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {primaryIde ? `Open in ${primaryIde.name}` : "No IDE found"}
          </TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={loading}
                  aria-label="Open in IDE"
                >
                  <Code className="h-3.5 w-3.5" />
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Open in IDE</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start">
            {ides.map((ide) => (
              <DropdownMenuItem key={ide.id} onClick={() => handleOpenInIDE(ide.id)}>
                {ide.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleRevealInFinder}
            aria-label="Reveal in file manager"
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Reveal in file manager</TooltipContent>
      </Tooltip>
    </span>
  );
}
