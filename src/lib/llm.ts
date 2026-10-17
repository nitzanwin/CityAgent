// The only file that knows which model provider we use. Everything else calls chat() with OpenAI-style
// messages and tools, so switching provider means re-implementing this one function.
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type LlmMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: object } };
export type ChatRequest = { model: string; messages: LlmMessage[]; tools?: ToolSpec[]; maxTokens?: number; temperature?: number; logprobs?: boolean; signal?: AbortSignal };
export type ChatResult = { content: string | null; toolCalls: ToolCall[]; top?: { token: string; logprob: number }[] };
export type Chat = (request: ChatRequest) => Promise<ChatResult>;

// OpenAI directly by default; any OpenAI-compatible endpoint (e.g. Vercel AI Gateway, https://ai-gateway.vercel.sh/v1,
// with models named like "openai/gpt-4.1") by setting LLM_BASE_URL and LLM_API_KEY.
const baseUrl = () => process.env.LLM_BASE_URL || "https://api.openai.com/v1";
const apiKey = () => process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
export const llmConfigured = () => Boolean(apiKey());
// Small and fast for yes/no checks (one token + confidence); a stronger model for the conversation itself.
// Rate limits are per model, so the high-volume gates sit on a different model from the conversation.
export const models = {
  gate: () => process.env.LLM_GATE_MODEL || "gpt-4.1-nano",
  agent: () => process.env.LLM_AGENT_MODEL || "gpt-4.1",
  // Used when the conversation model is rate-limited (limits are per model, so this one has its own allowance).
  agentFallback: () => process.env.LLM_AGENT_FALLBACK_MODEL || "gpt-4.1-mini",
};
export const isRateLimit = (e: unknown) => /\b429\b|rate limit/i.test(String(e));

// Reasoning models take reasoning_effort and max_completion_tokens, and reject temperature/logprobs.
const effort = (model: string) => /^gpt-5(-|$)/.test(model) ? "minimal" : /^(gpt-5\.|gpt-6)/.test(model) ? "none" : /^o\d/.test(model) ? "low" : null;

export const chat: Chat = async ({ model, messages, tools, maxTokens, temperature, logprobs, signal }) => {
  const reasoning = effort(model.split("/").pop()!);
  const body = {
    model, messages,
    ...(tools?.length && { tools, parallel_tool_calls: true }),
    ...(reasoning
      ? { reasoning_effort: reasoning, ...(maxTokens && { max_completion_tokens: Math.max(maxTokens, 16) }) }
      : { ...(maxTokens && { max_tokens: maxTokens }), ...(temperature !== undefined && { temperature }), ...(logprobs && { logprobs: true, top_logprobs: 5 }) }),
  };
  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST", signal, cache: "no-store",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Model provider returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const choice = (await res.json()).choices?.[0];
  return { content: choice?.message?.content ?? null, toolCalls: choice?.message?.tool_calls ?? [], top: choice?.logprobs?.content?.[0]?.top_logprobs };
};
