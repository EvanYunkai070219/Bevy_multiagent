import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { WorkspaceImage, isWorkspacePath } from "./WorkspaceFile";

interface MarkdownTextProps {
  children: string;
  className?: string;
  /**
   * Whose workspace a relative path refers to. Given one, an image the agent
   * wrote renders instead of arriving as a broken frame pointing at this app's
   * own origin.
   */
  agentId?: string;
}

export function MarkdownText({ children, className, agentId }: MarkdownTextProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(value) => {
          // A workspace path is not a URL and must survive sanitisation intact;
          // everything else goes through the default, which strips javascript:
          // and friends.
          if (agentId !== undefined && isWorkspacePath(value)) return value;
          return defaultUrlTransform(value);
        }}
        components={{
          a: ({ children: linkChildren, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {linkChildren}
            </a>
          ),
          img: ({ src, alt }) => {
            const url = typeof src === "string" ? src : "";
            if (agentId !== undefined && url.length > 0 && isWorkspacePath(url)) {
              return <WorkspaceImage agentId={agentId} path={url} alt={alt ?? ""} />;
            }
            return <img src={url} alt={alt ?? ""} />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
