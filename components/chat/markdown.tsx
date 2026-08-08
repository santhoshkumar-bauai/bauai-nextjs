"use client";

import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

type MarkdownComponents = ComponentProps<typeof ReactMarkdown>["components"];

/**
 * Assistant-message markdown. react-markdown never renders raw HTML, so model
 * output (and anything prompt-injected into it) stays inert text. Styling is
 * inline via component overrides — the repo has no typography plugin.
 */
const components: MarkdownComponents = {
  h1: ({ children }) => (
    <p className="mt-3 mb-1 text-[1.05em] font-bold first:mt-0">{children}</p>
  ),
  h2: ({ children }) => (
    <p className="mt-3 mb-1 text-[1.02em] font-bold first:mt-0">{children}</p>
  ),
  h3: ({ children }) => (
    <p className="mt-3 mb-1 font-bold first:mt-0">{children}</p>
  ),
  h4: ({ children }) => (
    <p className="mt-2 mb-1 font-semibold first:mt-0">{children}</p>
  ),
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-1.5 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="[&>p]:my-0">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-primary/40 pl-2.5 italic opacity-90">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => (
    <code
      className={cn(
        "rounded bg-foreground/8 px-1 py-0.5 font-mono text-[.9em]",
        className,
      )}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg bg-foreground/5 p-2.5 [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-2.5 border-border" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[.95em]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted/60 px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-2 py-1 align-top">{children}</td>
  ),
};

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
