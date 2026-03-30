import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface MarkdownViewerProps {
  content: string;
  className?: string;
}

/**
 * MarkdownViewer - Renders markdown content with syntax highlighting
 * Supports: code blocks, inline code, lists, bold, italic, links, headers
 */
export function MarkdownViewer({ content, className = '' }: MarkdownViewerProps) {
  return (
    <div className={`markdown-viewer ${className}`}>
      <ReactMarkdown
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const isInline = !match && !String(children).includes('\n');

            if (isInline) {
              return (
                <code
                  className="px-1.5 py-0.5 rounded bg-slate-700 text-sm font-mono text-pink-300"
                  {...props}
                >
                  {children}
                </code>
              );
            }

            return (
              <SyntaxHighlighter
                style={oneDark}
                language={match ? match[1] : 'text'}
                PreTag="div"
                customStyle={{
                  margin: '0.5rem 0',
                  borderRadius: '0.375rem',
                  fontSize: '0.875rem',
                }}
              >
                {String(children).replace(/\n$/, '')}
              </SyntaxHighlighter>
            );
          },
          // Style list items
          li({ children, ...props }) {
            return (
              <li className="ml-4 list-disc" {...props}>
                {children}
              </li>
            );
          },
          // Style paragraphs
          p({ children, ...props }) {
            return (
              <p className="mb-2 last:mb-0" {...props}>
                {children}
              </p>
            );
          },
          // Style strong/bold
          strong({ children, ...props }) {
            return (
              <strong className="font-semibold text-white" {...props}>
                {children}
              </strong>
            );
          },
          // Style emphasis/italic
          em({ children, ...props }) {
            return (
              <em className="italic text-slate-300" {...props}>
                {children}
              </em>
            );
          },
          // Style links
          a({ children, href, ...props }) {
            return (
              <a
                href={href}
                className="text-blue-400 hover:text-blue-300 underline"
                target="_blank"
                rel="noopener noreferrer"
                {...props}
              >
                {children}
              </a>
            );
          },
          // Style headers
          h1({ children, ...props }) {
            return (
              <h1 className="text-xl font-bold text-white mb-2" {...props}>
                {children}
              </h1>
            );
          },
          h2({ children, ...props }) {
            return (
              <h2 className="text-lg font-semibold text-white mb-2" {...props}>
                {children}
              </h2>
            );
          },
          h3({ children, ...props }) {
            return (
              <h3 className="text-base font-medium text-white mb-1" {...props}>
                {children}
              </h3>
            );
          },
          // Style blockquotes
          blockquote({ children, ...props }) {
            return (
              <blockquote
                className="border-l-4 border-slate-600 pl-4 italic text-slate-400 my-2"
                {...props}
              >
                {children}
              </blockquote>
            );
          },
          // Style unordered lists
          ul({ children, ...props }) {
            return (
              <ul className="my-2 space-y-1" {...props}>
                {children}
              </ul>
            );
          },
          // Style ordered lists
          ol({ children, ...props }) {
            return (
              <ol className="my-2 space-y-1 list-decimal" {...props}>
                {children}
              </ol>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownViewer;
