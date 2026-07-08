/**
 * langchainClient.js  (zero-dependency version)
 * ------------------------------------------------------------------
 * There is no way to use the real `langchain` npm package without npm
 * downloading it — so this file hand-rolls the same three-stage shape
 * LangChain uses, with plain Node.js classes and the built-in `https`
 * module. No install step, no node_modules, nothing to fetch.
 *
 * THE PATTERN (same idea as real LangChain's LCEL):
 *
 *   NovaPromptTemplate   -> turns chat history into a messages[] array
 *   ChatNVIDIA            -> sends messages[] to NVIDIA, streams back
 *                            { content } chunks as the model replies
 *   StringOutputParser    -> unwraps each chunk down to plain text
 *
 * streamNovaResponse() at the bottom wires the three together and is
 * the only thing server.js calls.
 * ------------------------------------------------------------------
 */

"use strict";

const https = require("https");

// NVIDIA's OpenAI-compatible chat completions endpoint.
const NVIDIA_HOSTNAME = "integrate.api.nvidia.com";
const NVIDIA_PATH = "/v1/chat/completions";

// Model id as listed on build.nvidia.com for NVIDIA NIM.
// The current NVIDIA catalog requires the full model namespace.
const MODEL_NAME = "mistralai/mistral-nemotron";
const FALLBACK_MODEL_NAME = "nvidia/llama-3.1-70b-instruct";
const MODEL_CANDIDATES = [MODEL_NAME, FALLBACK_MODEL_NAME];

// Nova's personality. Kept in one place so tone is easy to tune.
const NOVA_SYSTEM_PROMPT = `You are Nova a sharp, warm and very smart, and precise AI assistant.
Answer clearly and concisely. When helpful, structure answers with Markdown
(headings, bold, bullet lists, code blocks with language tags) — the client
renders Markdown, so use it whenever it improves readability. Avoid filler
and unnecessary apologies. If you don't know something, say so plainly.If any one asks "who made you" like these questions and which company made you then answer ,I am made by lakshit sharma from kotputli rajasthan , india and his born on 30 january 2012 who also made pacify intelligence company, and your company name who made you is Pacify intelligence`;

// ------------------------------------------------------------------
// STAGE 1 — Prompt template
// Job: take the running conversation and produce the exact messages[]
// array the API expects, with the system prompt pinned to the front.
// ------------------------------------------------------------------
class NovaPromptTemplate {
  constructor(systemPrompt) {
    this.systemPrompt = systemPrompt;
  }

  /** @param {{role: "user"|"assistant", content: string}[]} chatHistory */
  format(chatHistory) {
    return [{ role: "system", content: this.systemPrompt }, ...chatHistory];
  }
}

// ------------------------------------------------------------------
// Low-level HTTP: opens a streaming POST request to NVIDIA and hands
// back the raw response stream. Kept separate from the class below so
// the "how do I talk HTTPS" logic doesn't clutter the model's API.
// ------------------------------------------------------------------
function openNvidiaStream({ apiKey, model, messages, temperature, topP, maxTokens }) {
  const payload = JSON.stringify({
    model,
    messages,
    temperature,
    top_p: topP,
    max_tokens: maxTokens,
    stream: true, // ask NVIDIA for Server-Sent-Events, token by token
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: NVIDIA_HOSTNAME,
        path: NVIDIA_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let errorBody = "";
          res.on("data", (d) => (errorBody += d));
          res.on("end", () => {
            const safeBody = errorBody.trim() || "no body";
            let accountHint = "";
            if (res.statusCode === 404) {
              accountHint =
                " Check your NVIDIA API key and make sure your account has chat/completions access for the requested model.";
            }
            reject(
              new Error(`NVIDIA API error ${res.statusCode}: ${safeBody}.${accountHint}`)
            );
          });
          return;
        }
        resolve(res);
      }
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Parses NVIDIA's Server-Sent-Events stream into plain text deltas.
 * SSE frames look like:  "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n"
 * ending in:             "data: [DONE]\n\n"
 */
async function* parseSseTextDeltas(httpResponseStream) {
  let buffer = "";

  for await (const rawChunk of httpResponseStream) {
    // Normalize line endings so the "\n\n" frame separator always matches.
    buffer += rawChunk.toString("utf8").replace(/\r\n/g, "\n");

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);

      if (!frame.startsWith("data:")) continue; // skip SSE comments/keep-alives
      const data = frame.slice(5).trim();
      if (data === "[DONE]") return;

      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // A malformed/partial frame — safe to skip, more data is coming.
      }
    }
  }
}

// ------------------------------------------------------------------
// STAGE 2 — The model
// Job: send messages[] to NVIDIA, stream back message-chunk objects
// (mirrors how real LangChain models stream `AIMessageChunk` objects
// rather than bare strings, which is why STAGE 3 exists below).
// ------------------------------------------------------------------
class ChatNVIDIA {
  constructor({ apiKey, model, temperature, topP, maxTokens }) {
    this.apiKey = apiKey;
    this.model = model;
    this.temperature = temperature;
    this.topP = topP;
    this.maxTokens = maxTokens;
  }

  /** @param {{role: string, content: string}[]} messages */
  async *stream(messages) {
    const httpResponseStream = await openNvidiaStream({
      apiKey: this.apiKey,
      model: this.model,
      messages,
      temperature: this.temperature,
      topP: this.topP,
      maxTokens: this.maxTokens,
    });

    for await (const textDelta of parseSseTextDeltas(httpResponseStream)) {
      yield { content: textDelta };
    }
  }
}

// ------------------------------------------------------------------
// STAGE 3 — Output parser
// Job: unwrap { content } chunks into plain strings. Doing this as
// its own stage (rather than inline in ChatNVIDIA) means server.js —
// or anything else consuming this chain — only ever deals with plain
// text, never the model's internal chunk shape.
// ------------------------------------------------------------------
class StringOutputParser {
  async *parse(messageChunkStream) {
    for await (const chunk of messageChunkStream) {
      if (chunk.content) yield chunk.content;
    }
  }
}

function shouldRetryWithAlternativeModel(error) {
  const message = error && error.message ? error.message : String(error || "");
  return /degraded function|function id/i.test(message);
}

async function* streamFromModel({ apiKey, modelName, chatHistory }) {
  const prompt = new NovaPromptTemplate(NOVA_SYSTEM_PROMPT);
  const model = new ChatNVIDIA({
    apiKey,
    model: modelName,
    temperature: 0.6,
    topP: 0.9,
    maxTokens: 1024,
  });
  const parser = new StringOutputParser();

  const messages = prompt.format(chatHistory);
  const messageChunks = model.stream(messages);
  yield* parser.parse(messageChunks);
}

// ------------------------------------------------------------------
// The chain: prompt -> model -> parser, wired together explicitly.
// This is the only export server.js needs.
// ------------------------------------------------------------------

/**
 * Streams Nova's reply as an async generator of plain text chunks.
 * Usage: `for await (const chunk of streamNovaResponse(messages)) { ... }`
 *
 * @param {{role: "user"|"assistant", content: string}[]} chatHistory
 */
async function* streamNovaResponse(chatHistory) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing NVIDIA_API_KEY environment variable. Set it in Netlify Site settings → Environment."
    );
  }

  let lastError;
  for (let index = 0; index < MODEL_CANDIDATES.length; index += 1) {
    const modelName = MODEL_CANDIDATES[index];
    try {
      yield* streamFromModel({ apiKey, modelName, chatHistory });
      return;
    } catch (error) {
      lastError = error;
      const shouldRetry = index < MODEL_CANDIDATES.length - 1 && shouldRetryWithAlternativeModel(error);
      if (!shouldRetry) throw error;
      console.warn(
        `NVIDIA model "${modelName}" reported a degraded-function error. Retrying with "${MODEL_CANDIDATES[index + 1]}".`
      );
    }
  }

  throw lastError || new Error("NVIDIA request failed for all configured models.");
}

module.exports = {
  streamNovaResponse,
  hasApiKeyConfigured: () => Boolean(process.env.NVIDIA_API_KEY),
  shouldRetryWithAlternativeModel,
};
