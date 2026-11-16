import { useState } from "react";
import { FilePreviewModeToggle, type FilePreviewMode } from "@/components/FilePreviewModeToggle";
import { HtmlArtifactPreview } from "@/components/HtmlArtifactPreview";

/** Read-only view of an HTML issue document: sandboxed render, or raw source. */
export function HtmlDocumentBody({ html, title }: { html: string; title: string }) {
  const [mode, setMode] = useState<FilePreviewMode>("rendered");
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <FilePreviewModeToggle mode={mode} onChange={setMode} label={`${title} view mode`} />
      </div>
      {mode === "rendered" ? (
        <div className="flex h-[70vh] min-h-64 flex-col overflow-hidden rounded-md border border-border">
          <HtmlArtifactPreview html={html} title={title} />
        </div>
      ) : (
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words font-mono text-sm" aria-label={`${title} raw HTML`}>{html}</pre>
      )}
    </div>
  );
}
