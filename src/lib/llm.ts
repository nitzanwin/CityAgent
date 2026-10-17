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

export const llmConfigured = () => Boolean(process.env.OPENAI_API_KEY);
// Small and fast for yes/no checks (one token + confidence); a stronger model for the conversation itself.
export const models = {
  gate: () => process.env.LLM_GATE_MODEL || "gpt-4.1-nano",
  agent: () => process.env.LLM_AGENT_MODEL || "gpt-4.1-mini",
};

// Reasoning models take reasoning_effort and max_completion_tokens, and reject temperature/logprobs.
const effort = (model: string) => /^gpt-5(-|$)/.test(model) ? "minimal" : /^(gpt-5\.|gpt-6)/.test(model) ? "none" : /^o\d/.test(model) ? "low" : null;

export const chat: Chat = async ({ model, messages, tools, maxTokens, temperature, logprobs, signal }) => {
  const reasoning = effort(model);
  const body = {
    model, messages,
    ...(tools?.length && { tools, parallel_tool_calls: true }),
    ...(reasoning
      ? { reasoning_effort: reasoning, ...(maxTokens && { max_completion_tokens: Math.max(maxTokens, 16) }) }
      : { ...(maxTokens && { max_tokens: maxTokens }), ...(temperature !== undefined && { temperature }), ...(logprobs && { logprobs: true, top_logprobs: 5 }) }),
  };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", signal, cache: "no-store",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Model provider returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const choice = (await res.json()).choices?.[0];
  return { content: choice?.message?.content ?? null, toolCalls: choice?.message?.tool_calls ?? [], top: choice?.logprobs?.content?.[0]?.top_logprobs };
};
