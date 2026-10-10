import { classifyByRules } from './rules.js';
import { classifyByLlm } from './llm.js';
import type { PageObservation } from '../sources/types.js';
import type { StockStatus } from '../types.js';

export interface Extraction {
  status: StockStatus;
  price: number | null;
  method: 'rule' | 'llm';
  evidence: string;
}

/** Rules first; the LLM only sees what the rules couldn't settle. */
export async function extractStatus(obs: PageObservation): Promise<Extraction> {
  const rule = classifyByRules(obs);
  if (rule) return { status: rule.status, price: obs.price, method: 'rule', evidence: rule.reason };

  const llm = await classifyByLlm(obs);
  return { status: llm.status, price: obs.price, method: 'llm', evidence: llm.reason };
}
