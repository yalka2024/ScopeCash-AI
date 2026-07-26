import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';

// Renders streamed assistant text as LIVE markdown with syntax-highlighted code.
// `text` grows token-by-token as SSE `text` events arrive; markdown re-renders
// incrementally. A blinking caret shows while `streaming` is true.
export default function StreamingMessage({ text, streaming }) {
  return (
    <div className="max-w-none leading-relaxed text-foreground [&_a]:text-primary [&_a]:underline [&_code]:text-sm [&_h1]:mt-4 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[#0d1117] [&_pre]:p-4 [&_table]:my-3 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text || ''}
      </ReactMarkdown>
      {streaming ? <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-primary align-middle" aria-hidden="true" /> : null}
    </div>
  );
}

