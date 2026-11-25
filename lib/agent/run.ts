import { createAgent } from "langchain";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { AgentStep, AnswerResult, RepoIndex, SupportedModel } from "../types";
import { buildTools } from "./tools";
import { lexicalAnswer } from "./lexicalAnswer";

export class ApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyError";
  }
}

const SYSTEM_PROMPT = `You are CodeLens, a code research agent. You answer questions ONLY about the repository that has been loaded, using the tools provided. Never answer from general knowledge, and never invent code, file names, or line numbers.

Rules:
- Always call search_code first. Read files with read_file and look up names with find_symbol when you need detail.
- Every factual claim in your answer must carry a citation in the form path:line, e.g. index.js:42. Use only citations that came from a tool result.
- If the tools find nothing relevant, say clearly that the repo does not contain it — do not guess.
- Answer in the same language as the question (English or Urdu).
- Keep answers focused and short. Quote short code excerpts only when they help.`;

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text: unknown }).text);
        }
        return "";
      })
      .join("");
  }
  return "";
}

function isApiKeyFailure(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${"cause" in err ? String((err as { cause?: unknown }).cause ?? "") : ""}` : String(err);
  return /API_KEY_INVALID|API key not valid|401|403|PERMISSION_DENIED|invalid api key/i.test(text);
}

export async function runAgent(
  index: RepoIndex,
  question: string,
  apiKey: string,
  model: SupportedModel,
  contextFile?: string,
): Promise<AnswerResult> {
  const chatModel = new ChatGoogleGenerativeAI({
    apiKey,
    model,
    temperature: 0,
  });
  const { tools, collectSources } = buildTools(index);
  const systemPrompt = contextFile
    ? `${SYSTEM_PROMPT}\n- The user currently has the file ${contextFile} open. When they say "this file", they mean ${contextFile}.`
    : SYSTEM_PROMPT;
  const agent = createAgent({
    model: chatModel,
    tools,
    systemPrompt,
  });

  let result: Awaited<ReturnType<typeof agent.invoke>>;
  try {
    result = await agent.invoke({
      messages: [{ role: "user", content: question }],
    });
  } catch (err) {
    if (isApiKeyFailure(err)) {
      throw new ApiKeyError(
        "Gemini rejected the API key. Check the key in Settings — it must be a valid key from https://aistudio.google.com/app/apikey — then try again.",
      );
    }
    throw err;
  }

  const messages = result.messages ?? [];
  const steps: AgentStep[] = [];
  let answer = "";

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as {
      content?: unknown;
      tool_calls?: Array<{ name?: string; args?: unknown }>;
      getType?: () => string;
    };
    const type = typeof msg.getType === "function" ? msg.getType() : "";
    if (type === "ai" || (msg.tool_calls && msg.tool_calls.length > 0)) {
      const text = messageText(msg.content);
      if (text.trim()) answer = text;
      for (const call of msg.tool_calls ?? []) {
        const next = messages[i + 1] as { content?: unknown } | undefined;
        steps.push({
          tool: call.name ?? "unknown",
          input: JSON.stringify(call.args ?? {}),
          output: messageText(next?.content).slice(0, 800),
        });
      }
    }
  }

  if (!answer.trim()) {
    // The agent produced no text: fall back to the deterministic lexical answer.
    const fallback = await lexicalAnswer(index, question, contextFile);
    return {
      ...fallback,
      note: "The agent returned no text, so this is the lexical fallback answer built from keyword search.",
    };
  }

  return {
    answer,
    mode: "agent",
    steps,
    sources: collectSources(),
    model,
    note: null,
  };
}
