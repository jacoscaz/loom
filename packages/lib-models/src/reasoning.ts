/**
 * Reasoning-effort vocabulary: the common language for how hard a
 * completion model should think. Adapters translate these to their native
 * equivalents (the OpenAI adapter passes them through unchanged); adapters
 * with no notion of reasoning effort no-op the request (log + false).
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
