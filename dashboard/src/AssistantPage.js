import React, { useState, useEffect, useRef } from 'react';
import { listAgents, streamAgentRun } from './api';
import StreamingMessage from './components/StreamingMessage';
import ReasoningTrace from './components/ReasoningTrace';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';
import { Button } from './components/ui/button';
import { Send, Square, Sparkles } from 'lucide-react';

// Modern AI surface: streams tokens live (no frozen UI) and shows a collapsible
// Chain-of-Thought (reasoning + tool steps) above the answer. Consumes the SSE
// emitted by POST /api/agents/:name/run/stream.
export default function AssistantPage() {
  const [agents, setAgents] = useState([]);
  const [agent, setAgent] = useState('');
  const [input, setInput] = useState('');
  const [answer, setAnswer] = useState('');
  const [steps, setSteps] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef(null);

  useEffect(() => {
    listAgents()
      .then((d) => {
        const list = (d && d.agents) || [];
        setAgents(list);
        if (list.length) setAgent(list[0].name);
      })
      .catch(() => {});
  }, []);

  async function run(e) {
    if (e) e.preventDefault();
    if (!input.trim() || !agent || streaming) return;
    setAnswer(''); setSteps([]); setError(''); setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamAgentRun(agent, input, {
        signal: controller.signal,
        onEvent: (evt) => {
          if (evt.type === 'text' && evt.text) setAnswer((a) => a + evt.text);
          else if (evt.type === 'final' && evt.output != null) setAnswer(evt.output);
          else if (evt.type === 'step') setSteps((s) => [...s, { type: 'step', label: `Step ${evt.step}`, detail: evt.agent }]);
          else if (evt.type === 'tool') setSteps((s) => [...s, { type: 'tool', label: `Tool: ${evt.name}` }]);
          else if (evt.type === 'escalate') setSteps((s) => [...s, { type: 'escalate', label: 'Escalated model', detail: `${evt.from} → ${evt.to}` }]);
          else if (evt.type === 'error') setError(evt.error || 'Agent error');
        },
      });
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message || 'Stream failed');
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function stop() {
    if (abortRef.current) abortRef.current.abort();
    setStreaming(false);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center gap-2">
        <Sparkles className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-semibold text-foreground">AI Assistant</h1>
      </div>

      <Card className="mb-4">
        <CardContent className="p-4">
          <form onSubmit={run} className="flex flex-col gap-3">
            {agents.length > 1 && (
              <select
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                className="h-9 w-fit rounded-md border border-border bg-background px-2 text-sm text-foreground"
              >
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>{a.name}</option>
                ))}
              </select>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={3}
              placeholder="Ask anything…  (⌘/Ctrl + Enter to send)"
              className="w-full resize-y rounded-md border border-border bg-background p-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(e); }}
            />
            <div className="flex items-center gap-2">
              {streaming ? (
                <Button type="button" variant="outline" onClick={stop}><Square className="h-4 w-4" /> Stop</Button>
              ) : (
                <Button type="submit" disabled={!input.trim() || !agent}><Send className="h-4 w-4" /> Send</Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {error ? (
        <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>
      ) : null}

      {(answer || streaming || steps.length > 0) ? (
        <Card>
          <CardHeader><CardTitle>Response</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {steps.length > 0 ? <ReasoningTrace steps={steps} /> : null}
            <StreamingMessage text={answer} streaming={streaming} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

