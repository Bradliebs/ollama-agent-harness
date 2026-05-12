// Council adapter — bridges the pure model council to the harness's chat
// clients (OllamaClient / OpenAIClient via IChatClient).

import type { IChatClient } from '../core/chatClient';
import { runCouncil, type CouncilMember, type CouncilMode, type CouncilResult, type Invoke } from './modelCouncil';

export interface CouncilForChatOptions {
  /** Models to dispatch to in parallel. */
  members: CouncilMember[];
  mode: CouncilMode;
  /** Required for debate / arbiter modes. */
  arbiter?: string;
  perMemberTimeoutMs?: number;
}

export type CouncilClientFactory = (model: string) => Pick<IChatClient, 'chat'>;

/**
 * Run a model council against a single user prompt using the supplied
 * chat client factory. Each member spins up its own client (or reuses one
 * from the factory) so the parallel dispatch is genuine.
 */
export async function runCouncilForChat(
  prompt: string,
  options: CouncilForChatOptions,
  factory: CouncilClientFactory,
): Promise<CouncilResult> {
  const invoke: Invoke = async (model: string, p: string) => {
    const client = factory(model);
    const result = await client.chat([{ role: 'user', content: p }], [], undefined);
    const message = result.message?.content ?? '';
    return typeof message === 'string' ? message : JSON.stringify(message);
  };
  return runCouncil(prompt, options, invoke);
}
