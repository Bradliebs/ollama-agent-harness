/**
 * Live reply preview for LoopConfig.streamText. The chat client reports the
 * reply text so far through ChatOptions.onContent; `until()` turns that into
 * small deltas the loop can yield while the model call is still running.
 * Consumers that read slowly simply get bigger deltas.
 */
export interface TextPreviewDelta {
  content: string;
  /** The preview starts over (the call was retried, or the text turned out to be a tool call). */
  reset: boolean;
}

export interface TextPreview {
  onContent: (contentSoFar: string) => void;
  until: (settled: Promise<unknown>) => AsyncGenerator<TextPreviewDelta>;
}

/**
 * Text that is (the start of) an inline tool call — some models write the
 * call as JSON in the reply — isn't previewed; it would flash and vanish.
 */
function previewable(text: string): string {
  const start = text.trimStart();
  if (!start || /^[{[]/.test(start) || /^<(tool|function)/i.test(start)) return '';
  return text;
}

export function createTextPreview(): TextPreview {
  let latest = '';
  let emitted = '';
  let wake: (() => void) | null = null;

  const next = (): TextPreviewDelta | null => {
    const shown = previewable(latest);
    if (shown === emitted) return null;
    if (shown.startsWith(emitted)) {
      const content = shown.slice(emitted.length);
      emitted = shown;
      return { content, reset: false };
    }
    emitted = shown;
    return { content: shown, reset: true };
  };

  return {
    onContent(contentSoFar: string): void {
      latest = contentSoFar;
      const resume = wake;
      wake = null;
      resume?.();
    },
    async *until(settled: Promise<unknown>): AsyncGenerator<TextPreviewDelta> {
      let done = false;
      const finished = settled.then(() => { done = true; }, () => { done = true; });
      for (;;) {
        if (done) return;
        const delta = next();
        if (delta) {
          yield delta;
          continue;
        }
        await Promise.race([finished, new Promise<void>((resolve) => { wake = resolve; })]);
      }
    },
  };
}
