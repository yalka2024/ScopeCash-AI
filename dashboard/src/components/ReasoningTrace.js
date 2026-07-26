import * as React from 'react';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from './ui/accordion';
import { Brain, Wrench, ArrowUpRight, CheckCircle2 } from 'lucide-react';

// Visual Chain-of-Thought. Renders the `step` / `tool` / `escalate` SSE events
// emitted by /api/agents/:name/run/stream as a collapsible reasoning trace, so
// the user can see HOW the agent worked — not just the final answer.
function iconFor(type) {
  if (type === 'tool') return <Wrench className="mt-0.5 h-3.5 w-3.5 text-primary" />;
  if (type === 'escalate') return <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 text-primary" />;
  return <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-primary" />;
}

export default function ReasoningTrace({ steps }) {
  if (!steps || steps.length === 0) return null;
  return (
    <Accordion type="single" collapsible className="rounded-lg border border-border bg-muted/30 px-3">
      <AccordionItem value="trace" className="border-b-0">
        <AccordionTrigger className="text-muted-foreground">
          <span className="flex items-center gap-2">
            <Brain className="h-4 w-4" /> Reasoning &amp; tools ({steps.length} {steps.length === 1 ? 'step' : 'steps'})
          </span>
        </AccordionTrigger>
        <AccordionContent>
          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-muted-foreground">
                {iconFor(s.type)}
                <span>
                  <span className="font-medium text-foreground">{s.label || s.type}</span>
                  {s.detail ? <span className="opacity-80"> — {s.detail}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

