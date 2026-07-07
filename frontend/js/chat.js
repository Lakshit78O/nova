/**
 * chat.js
 * ------------------------------------------------------------------
 * Everything the Chat page needs client-side:
 *   1. Keep a running conversation history in memory.
 *   2. Send it to POST /api/chat and read the streamed reply.
 *   3. Render the AI's Markdown safely (marked.js -> DOMPurify -> DOM).
 *   4. Handle the small UI details: auto-growing textarea, the
 *      "Nova is thinking" indicator, code-block copy buttons, errors.
 *
 * No framework, no build step — just the browser's native fetch +
 * ReadableStream APIs.
 * ------------------------------------------------------------------
 */
(function () {
  "use strict";

  // ---- DOM references -------------------------------------------------
  const scrollEl      = document.getElementById("chat-scroll");
  const transcriptEl   = document.getElementById("chat-transcript");
  const welcomeEl      = document.getElementById("chat-welcome");
  const form           = document.getElementById("composer-form");
  const inputEl        = document.getElementById("chat-input");
  const sendBtn        = document.getElementById("send-btn");
  const clearBtn       = document.getElementById("clear-btn");
  const errorEl        = document.getElementById("chat-error");
  const statusDot      = document.getElementById("status-dot");
  const statusText     = document.getElementById("status-text");

  const CHAT_ENDPOINT = "/.netlify/functions/chat";

  // Conversation history sent to the backend on every turn.
  // Kept simple and stateless server-side: the browser is the source of truth.
  let history = [];
  let isStreaming = false;

  // Configure marked.js once: GitHub-flavoured line breaks feel more
  // natural in chat than marked's default "one blank line = paragraph".
  marked.setOptions({ breaks: true, gfm: true });

  // ---- Textarea auto-grow ----------------------------------------------
  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  }
  inputEl.addEventListener("input", () => {
    autoGrow();
    sendBtn.disabled = inputEl.value.trim().length === 0 || isStreaming;
  });

  // Enter sends, Shift+Enter makes a new line.
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // Suggested prompt chips on the empty state.
  document.querySelectorAll(".prompt-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      inputEl.value = chip.dataset.prompt;
      autoGrow();
      form.requestSubmit();
    });
  });

  clearBtn.addEventListener("click", () => {
    if (isStreaming) return; // don't interrupt an in-flight reply
    history = [];
    transcriptEl.innerHTML = "";
    transcriptEl.appendChild(welcomeEl);
    hideError();
  });

  // ---- Sending a message -------------------------------------------------
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text || isStreaming) return;

    // First message: swap out the empty state.
    if (welcomeEl.isConnected) welcomeEl.remove();

    appendUserMessage(text);
    history.push({ role: "user", content: text });

    inputEl.value = "";
    autoGrow();
    sendBtn.disabled = true;
    hideError();

    await streamAiReply();
  });

  function appendUserMessage(text) {
    const row = document.createElement("div");
    row.className = "msg msg--user";
    row.innerHTML = `
      <div class="msg__avatar">You</div>
      <div class="msg__bubble"></div>
    `;
    // Plain text, not Markdown — set via textContent to avoid any HTML injection.
    row.querySelector(".msg__bubble").textContent = text;
    transcriptEl.appendChild(row);
    scrollToBottom();
  }

  function appendThinkingRow() {
    const row = document.createElement("div");
    row.className = "thinking-row";
    row.id = "thinking-row";
    row.innerHTML = `
      <span class="nova-mark" style="--size:20px;">
        <span class="nova-mark__ray"></span><span class="nova-mark__ray"></span>
        <span class="nova-mark__ray"></span><span class="nova-mark__ray"></span>
        <span class="nova-mark__core"></span>
      </span>
      <span>Nova is thinking…</span>
    `;
    transcriptEl.appendChild(row);
    scrollToBottom();
    return row;
  }

  /**
   * Sends the full conversation history to the backend and streams the
   * reply into a new AI bubble, re-rendering Markdown as chunks arrive.
   */
  async function streamAiReply() {
    isStreaming = true;
    setStatus("thinking");

    const thinkingRow = appendThinkingRow();

    // Create the AI message row up front but keep it invisible-ish until
    // the first chunk lands, so "thinking" reads cleanly beforehand.
    const aiRow = document.createElement("div");
    aiRow.className = "msg msg--ai";
    aiRow.innerHTML = `
      <div class="msg__avatar">
        <span class="nova-mark" style="--size:18px;">
          <span class="nova-mark__ray"></span><span class="nova-mark__ray"></span>
          <span class="nova-mark__ray"></span><span class="nova-mark__ray"></span>
          <span class="nova-mark__core"></span>
        </span>
      </div>
      <div class="msg__bubble is-streaming"></div>
    `;
    const bubble = aiRow.querySelector(".msg__bubble");

    let fullText = "";
    let firstChunkReceived = false;

    try {
      const response = await fetch(CHAT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });

      if (!response.ok || !response.body) {
        const payload = await safeJson(response);
        throw new Error(payload?.error || `Server responded with ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      // Read the stream chunk by chunk as the server flushes tokens.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (!firstChunkReceived) {
          thinkingRow.remove();
          transcriptEl.appendChild(aiRow);
          firstChunkReceived = true;
        }

        fullText += decoder.decode(value, { stream: true });
        renderMarkdownInto(bubble, fullText);
        scrollToBottom();
      }

      if (!firstChunkReceived) {
        // Stream ended with zero bytes — treat as an error rather than
        // leaving a silently empty bubble.
        thinkingRow.remove();
        throw new Error("Nova didn't return a response.");
      }

      bubble.classList.remove("is-streaming");
      decorateCodeBlocks(bubble);
      history.push({ role: "assistant", content: fullText });
      setStatus("ready");
    } catch (err) {
      thinkingRow.remove();
      if (aiRow.isConnected) aiRow.remove();
      showError(err.message || "Something went wrong talking to Nova.");
      setStatus("offline");
    } finally {
      isStreaming = false;
      sendBtn.disabled = inputEl.value.trim().length === 0;
    }
  }

  // ---- Markdown rendering -------------------------------------------------
  /**
   * Parses `markdownText` with marked.js, sanitizes the resulting HTML
   * with DOMPurify, and writes it into `bubbleEl`. Called repeatedly while
   * streaming, so it stays cheap (no fixed-size buffers, direct innerHTML).
   */
  function renderMarkdownInto(bubbleEl, markdownText) {
    const normalizedMarkdown = normalizeHtmlTags(autoWrapBareLatex(markdownText));
    const rawHtml = marked.parse(normalizedMarkdown);
    const mathHtml = renderMathHtml(rawHtml);
    bubbleEl.innerHTML = DOMPurify.sanitize(mathHtml, {
      ADD_ATTR: ["target", "class", "style", "aria-hidden", "role"],
    });
    renderLatexInto(bubbleEl);
  }

  function normalizeHtmlTags(markdownText) {
    const allowedTags = new Set([
      "br", "p", "ul", "ol", "li", "strong", "em", "sub", "sup",
      "span", "b", "i", "u", "code", "pre", "blockquote",
      "h1", "h2", "h3", "h4", "h5", "h6",
    ]);
    // Normalize allowed tags (e.g. convert `< br >` to `<br>`) and
    // escape any disallowed tags so they render as literal text.
    return markdownText.replace(/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/)??\s*>/g, (match, slash, tag, selfClose) => {
      const normalizedTag = tag.toLowerCase();
      // If tag is allowed, return a minimal, normalized form without attributes.
      if (allowedTags.has(normalizedTag)) {
        if (selfClose) return `<${slash}${normalizedTag}/>`;
        return `<${slash}${normalizedTag}>`;
      }

      // Otherwise escape the angle brackets so the raw text is visible
      // instead of being interpreted as HTML. This fixes cases where
      // the model returns things like `< br >` or `< /strong >`.
      return match.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    });
  }

  function renderMathHtml(html) {
    if (!window.katex) return html;

    return html.replace(/\$\$([\s\S]+?)\$\$|(?<!\$)\$([^\n$]+?)\$(?!\$)/g, (match, displayMath, inlineMath) => {
      const source = displayMath ?? inlineMath;
      try {
        return katex.renderToString(source.trim(), {
          displayMode: Boolean(displayMath),
          throwOnError: false,
        });
      } catch (err) {
        return match;
      }
    });
  }

  function autoWrapBareLatex(markdownText) {
    const lines = markdownText.split("\n");
    let inFence = false;
    const fencedPattern = /^(```|~~~)/;
    const latexLinePattern = /\\[A-Za-z]+|\^\{?|_[A-Za-z0-9\{]|\\(?:frac|sqrt|Rightarrow|Leftarrow|implies|rightarrow|leftarrow|cdot|times|pm|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|nu|pi|sigma|phi|omega|sum|int|lim|infty|le|ge|neq)\b/;

    const result = [];

    for (const line of lines) {
      if (fencedPattern.test(line)) {
        inFence = !inFence;
        result.push(line);
        continue;
      }

      if (inFence) {
        result.push(line);
        continue;
      }

      const trimmed = line.trim();
      if (!trimmed) {
        result.push(line);
        continue;
      }

      // Skip lines already wrapped in standard math delimiters.
      if (trimmed.startsWith("$$") || trimmed.startsWith("$") || trimmed.startsWith("\\(") || trimmed.startsWith("\\[")) {
        result.push(line);
        continue;
      }

      if (latexLinePattern.test(line) && !/\$/.test(line)) {
        const cleaned = trimmed.replace(/\\\s*$/, "");
        result.push(`$$\n${cleaned}\n$$`);
        continue;
      }

      result.push(line);
    }

    return result.join("\n");
  }

  /**
   * Finds and renders LaTeX expressions (both inline $...$ and display $$...$$)
   * using KaTeX within the given element.
   */
  function renderLatexInto(element) {
    if (!window.renderMathInElement) return;

    // Only render math in text nodes outside code/pre blocks.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.includes("$")) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("pre, code")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    textNodes.forEach((textNode) => {
      const wrapper = document.createElement("span");
      wrapper.textContent = textNode.nodeValue;
      try {
        renderMathInElement(wrapper, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false },
            { left: "\\(", right: "\\)", display: false },
            { left: "\\[", right: "\\]", display: true },
          ],
          throwOnError: false,
          ignoredTags: ["script", "noscript", "style", "textarea", "code", "pre"],
        });
        if (wrapper.innerHTML !== textNode.nodeValue) {
          textNode.parentNode.replaceChild(wrapper, textNode);
        }
      } catch (err) {
        // leave the original text if KaTeX rendering fails
      }
    });
  }

  /**
   * After streaming finishes: run syntax highlighting and attach a
   * "Copy" button to every fenced code block in the bubble.
   */
  function decorateCodeBlocks(bubbleEl) {
    bubbleEl.querySelectorAll("pre > code").forEach((codeEl) => {
      if (window.hljs) hljs.highlightElement(codeEl);

      const pre = codeEl.parentElement;
      if (pre.parentElement.classList.contains("code-block")) return; // already wrapped

      const wrapper = document.createElement("div");
      wrapper.className = "code-block";
      pre.replaceWith(wrapper);
      wrapper.appendChild(pre);

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "code-block__copy";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", () => copyCode(codeEl, copyBtn));
      wrapper.appendChild(copyBtn);
    });
    // Re-render LaTeX after decorating code blocks
    renderLatexInto(bubbleEl);
  }

  async function copyCode(codeEl, btn) {
    try {
      await navigator.clipboard.writeText(codeEl.textContent);
      btn.textContent = "Copied";
      btn.classList.add("is-copied");
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("is-copied");
      }, 1600);
    } catch {
      btn.textContent = "Press ⌘/Ctrl+C";
    }
  }

  // ---- Small helpers -------------------------------------------------
  function scrollToBottom() {
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function setStatus(state) {
    if (state === "thinking") {
      statusText.textContent = "Thinking…";
      statusDot.classList.remove("is-offline");
    } else if (state === "offline") {
      statusText.textContent = "Connection issue";
      statusDot.classList.add("is-offline");
    } else {
      statusText.textContent = "Ready";
      statusDot.classList.remove("is-offline");
    }
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.add("is-visible");
  }
  function hideError() {
    errorEl.classList.remove("is-visible");
    errorEl.textContent = "";
  }

  async function safeJson(response) {
    try { return await response.json(); } catch { return null; }
  }
})();
