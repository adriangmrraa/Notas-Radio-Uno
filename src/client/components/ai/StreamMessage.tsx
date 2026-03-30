import { useEffect, useState, useRef } from 'react';
import { MarkdownViewer } from './MarkdownViewer';

interface StreamMessageProps {
  /** The accumulated streaming content */
  content: string;
  /** Whether the stream is still active */
  isStreaming?: boolean;
  /** Callback when streaming starts */
  onStreamStart?: () => void;
  /** Callback when streaming ends */
  onStreamEnd?: () => void;
  /** Class name for container */
  className?: string;
}

/**
 * StreamMessage - Displays streaming AI content with typing indicator
 * Combines MarkdownViewer with a typing animation for live streaming content
 */
export function StreamMessage({
  content,
  isStreaming = false,
  onStreamStart,
  onStreamEnd,
  className = '',
}: StreamMessageProps) {
  const [displayContent, setDisplayContent] = useState(content);
  const [isTyping, setIsTyping] = useState(false);
  const contentRef = useRef(content);
  const prevContentLengthRef = useRef(content.length);

  // Update content when it changes (new chunks arrive)
  useEffect(() => {
    if (content !== contentRef.current) {
      // Content changed - this is new streaming data
      const wasEmpty = contentRef.current.length === 0;
      contentRef.current = content;
      setDisplayContent(content);

      // Notify about stream start if this is the first content
      if (wasEmpty && content.length > 0 && isStreaming) {
        setIsTyping(true);
        onStreamStart?.();
      }

      // Keep typing state while streaming
      if (isStreaming) {
        setIsTyping(true);
      }

      prevContentLengthRef.current = content.length;
    }
  }, [content, isStreaming, onStreamStart]);

  // Handle stream end
  useEffect(() => {
    if (!isStreaming && isTyping) {
      setIsTyping(false);
      onStreamEnd?.();
    }
  }, [isStreaming, isTyping, onStreamEnd]);

  // Don't show typing indicator for empty content
  const showTypingIndicator = isTyping && displayContent.length > 0;

  return (
    <div className={`stream-message ${className}`}>
      <MarkdownViewer content={displayContent} />
      
      {showTypingIndicator && (
        <div className="stream-typing-indicator mt-2 flex items-center gap-1">
          <span className="typing-dot bg-slate-400 w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="typing-dot bg-slate-400 w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="typing-dot bg-slate-400 w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          <span className="typing-text text-slate-400 text-sm ml-2">IA escribiendo...</span>
        </div>
      )}

      <style>{`
        .typing-dot {
          opacity: 0.7;
        }
        .typing-dot:nth-child(1) {
          animation-delay: 0ms;
        }
        .typing-dot:nth-child(2) {
          animation-delay: 150ms;
        }
        .typing-dot:nth-child(3) {
          animation-delay: 300ms;
        }
      `}</style>
    </div>
  );
}

// Standalone TypingIndicator component for external use
export function TypingIndicator({ className = '' }: { className?: string }) {
  return (
    <div className={`typing-indicator flex items-center gap-1 ${className}`}>
      <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '300ms' }} />
    </div>
  );
}

export default StreamMessage;
