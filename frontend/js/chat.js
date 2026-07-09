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
  const transcriptEl  = document.getElementById("chat-transcript");
  const welcomeEl     = document.getElementById("chat-welcome");
  const form          = document.getElementById("composer-form");
  const inputEl       = document.getElementById("chat-input");
  const sendBtn       = document.getElementById("send-btn");
  const clearBtn      = document.getElementById("clear-btn");
  const errorEl       = document.getElementById("chat-error");
  const statusDot     = document.getElementById("status-dot");
  const statusText    = document.getElementById("status-text");

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
    // FIX 1: Send button re-enable logic — was already correct here,
    // but the broken normalizeHtmlTags below caused JS parse errors that
    // prevented the whole script from running, making the button dead.
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
      // FIX 2: Enable send button when a prompt chip is clicked,
      // so the button is active before form.requestSubmit() fires.
      sendBtn.disabled = false;
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
    // FIX 3: Pipeline order — strip stray HTML tags first, then auto-wrap
    // bare LaTeX, then parse Markdown, then render any $...$ / $$...$$ math.
    // Previously autoWrapBareLatex ran before normalizeHtmlTags, so bare HTML
    // leaked through into the KaTeX pass and produced visible <br>, <ul>, <li>
    // tags and garbled word spacing in the rendered output.
    const cleanedMarkdown = normalizeHtmlTags(markdownText);
    const latexWrapped    = autoWrapBareLatex(cleanedMarkdown);
    const rawHtml         = marked.parse(latexWrapped);
    bubbleEl.innerHTML    = DOMPurify.sanitize(rawHtml, {
      // Allow KaTeX's span/classes and some mathml tags so math renders
      // correctly and stays inside the bubble instead of breaking out.
      ADD_TAGS: [
        "math", "mrow", "mi", "mo", "mn", "msup", "msub",
        "mfrac", "munder", "mover", "munderover", "msqrt",
        "mtable", "mtr", "mtd", "annotation", "semantics", "span",
        // Allow preview container elements so the LaTeX source preview isn't stripped
        "details", "summary", "pre", "code", "br"
      ],
      ADD_ATTR: ["target", "class", "style", "aria-hidden", "role",
                 "xmlns", "encoding", "columnalign", "open"],
    });
    // If the original markdown contained LaTeX, add a small collapsible
    // preview showing the raw LaTeX source so users can inspect it.
    try {
      const mathMatches = Array.from(latexWrapped.matchAll(/\$\$[\s\S]+?\$\$|\$[^\n$]+?\$/g)).map(m => m[0]);
      if (mathMatches.length) {
        const details = document.createElement("details");
        details.className = "latex-preview";
        const summary = document.createElement("summary");
        summary.textContent = "LaTeX source";
        const pre = document.createElement("pre");
        pre.textContent = mathMatches.join("\n\n");
        details.appendChild(summary);
        details.appendChild(pre);
        bubbleEl.appendChild(details);
      }
    } catch (e) {
      // no-op if regex or DOM operations fail in edge cases
    }

    // Render LaTeX in the sanitized DOM (use KaTeX's auto-render if present),
    // otherwise fall back to katex.renderToString on the sanitized HTML.
    renderLatexInto(bubbleEl);
  }

  /**
   * FIX 5: normalizeHtmlTags had a dangling `});` and a duplicate tail
   * (lines 243-249 in the original) that caused a SyntaxError, crashing
   * the entire script — which is why the send button never responded.
   *
   * Correct version: one clean function body, no orphaned closing brace.
   */
  function normalizeHtmlTags(markdownText) {
    let text = markdownText;

    // Convert block-level HTML tags to newlines so Markdown sees clean text.
    text = text.replace(/<\s*br\s*\/?\s*>/gi, "\n");
    text = text.replace(/<\s*(?:p|div|section|article|blockquote|h[1-6]|ul|ol|li|table|tr|td|th)[^>]*>/gi, "\n");
    text = text.replace(/<\s*\/\s*(?:p|div|section|article|blockquote|h[1-6]|ul|ol|li|table|tr|td|th)\s*>/gi, "\n");

    // Strip any remaining HTML tags, preserving a space so words don't merge.
    // FIX 6: Use " " (space) rather than "" so "word</tag>word" → "word word"
    // instead of "wordword", which was causing the missing-spaces bug.
    text = text.replace(/<[^>]+>/g, " ");

    // Normalise line endings.
    text = text.replace(/\r\n?/g, "\n");
    // Collapse runs of spaces/tabs on a single line (but keep newlines).
    text = text.replace(/[ \t]+/g, " ");
    // Collapse 3+ blank lines to one blank line.
    text = text.replace(/\n{3,}/g, "\n\n");
    // Remove leading/trailing spaces on each line.
    text = text.replace(/\n[ \t]+/g, "\n");
    text = text.replace(/[ \t]+\n/g, "\n");

    return text.trim();
  }

  // NOTE: We intentionally removed the earlier `renderMathHtml` approach
  // that pre-rendered KaTeX into the HTML string. That method could emit
  // markup that then got sanitized or mixed with Markdown output, causing
  // stray <br>, <ul>, <li> and spacing issues. Instead we sanitize first
  // and then run KaTeX's `renderMathInElement` in `renderLatexInto`.

  function autoWrapBareLatex(markdownText) {
    const lines = markdownText.split("\n");
    let inFence = false;
    const fencedPattern    = /^(```|~~~)/;
    const latexLinePattern = /\\[A-Za-z]+|\^\{?|_[A-Za-z0-9{]|\\(?:frac|sqrt|Rightarrow|Leftarrow|implies|rightarrow|leftarrow|cdot|times|pm|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|nu|pi|sigma|phi|omega|sum|int|lim|infty|le|ge|neq)\b/;

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

      // Handle common LLM output where LaTeX is wrapped in square brackets:
      // e.g. "[ \\sin \\theta = \\frac{8}{17} ]" -> treat as display math.
      const bracketMath = trimmed.match(/^\[\s*([\s\S]*\\[A-Za-z0-9]|[\^_]|\\frac|\\sqrt)[\s\S]*\s*\]$/);
      if (bracketMath) {
        // extract inner content without the surrounding brackets
        const inner = trimmed.replace(/^\[\s*|\s*\]$/g, "").trim();
        result.push(`\n$$\n${inner}\n$$\n`);
        continue;
      }

      // Skip lines already wrapped in standard math delimiters.
      if (
        trimmed.startsWith("$$") ||
        trimmed.startsWith("$") ||
        trimmed.startsWith("\\(") ||
        trimmed.startsWith("\\[")
      ) {
        result.push(line);
        continue;
      }

      if (latexLinePattern.test(line) && !/\$/.test(line)) {
        const cleaned = trimmed.replace(/\\\s*$/, "");
        // Surround display math with blank lines so it doesn't merge with
        // surrounding prose once KaTeX renders it.
        result.push(`\n$$\n${cleaned}\n$$\n`);
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
    const mathOptions = {
      delimiters: [
        { left: "$$", right: "$$", display: true  },
        { left: "$",  right: "$",  display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true  },
      ],
      throwOnError: false,
      ignoredTags: ["script", "noscript", "style", "textarea", "code", "pre"],
    };

    // Prefer KaTeX's auto-render if the page loaded it.
    try {
      if (typeof window.renderMathInElement === "function") {
        window.renderMathInElement(element, mathOptions);
        return;
      }

      // Fallback: if katex.renderToString is available, replace math
      // delimiters directly inside the sanitized HTML. This keeps markup
      // contained because we sanitized earlier and allowed KaTeX spans.
      if (window.katex && typeof window.katex.renderToString === "function") {
        const mathRe = /\$\$([\s\S]+?)\$\$|\$([^\n$]+?)\$/g;
        element.innerHTML = element.innerHTML.replace(mathRe, (match, displayMath, inlineMath) => {
          const source = (displayMath || inlineMath || "").trim();
          try {
            return window.katex.renderToString(source, { displayMode: Boolean(displayMath), throwOnError: false });
          } catch (err) {
            return match;
          }
        });
        return;
      }
    } catch (err) {
      // If rendering fails, silently leave the original markdown/text.
    }
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
    // Re-render LaTeX after decorating code blocks.
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