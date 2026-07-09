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

  // Shared by autoWrapBareLatex() and extractMath(): detects markdown
  // bold/italic syntax, and picks out math-looking clauses (e.g.
  // "f(x) = x^2 + 1", "y = 0") out of a larger run of prose. See FIX 8/9
  // below for why both are needed.
  const MD_EMPHASIS_PATTERN = /\*\*[^*\n]+\*\*|__[^_\n]+__/;
  // A variable/function name, an optional "(...)" call, then one-or-more
  // "<op> <token>" hops chained with =, ^, _, or +. Requires an explicit
  // operator to trigger, so ordinary words ("is", "not", "well-known")
  // never match — they have no = ^ _ + immediately following them.
  // Each token is either a bracket-free run of letters/digits/^/_/./+/- or
  // a real function call ("f(-1)") — never a bare "(" or ")" on its own,
  // so a clause can't swallow a closing paren that actually belongs to
  // surrounding prose, e.g. the "...)" in "(e.g., f(1) = f(-1) = 2)".
  const INLINE_CLAUSE_PATTERN = /\b[A-Za-z](?:\([^()\n]{1,20}\))?(?:\s*[=^_+]\s*(?:[A-Za-z]\([^()\n]{1,20}\)|[A-Za-z0-9^_.+-]+))+/g;

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
    // Pipeline order matters:
    //   1. strip stray HTML tags
    //   2. auto-wrap bare LaTeX (no $ delimiters) into $$...$$
    //   3. pre-render every $...$ / $$...$$ / \(...\) / \[...\] expression
    //      to KaTeX HTML *before* Markdown parsing, swapping each one for a
    //      one-token placeholder span
    //   4. run marked.parse + DOMPurify as before (placeholders are inert
    //      plain HTML, so Markdown can't split them across list items or
    //      paragraphs)
    //   5. swap the placeholders back for the real KaTeX markup
    //
    // FIX 7: The previous approach ran KaTeX's renderMathInElement *after*
    // Markdown had already turned the source into HTML. When an equation
    // like "$$\n1. (x^2 - 5x + 6)\n$$" sat next to a numbered list, marked
    // split it into separate <p>/<ol><li> elements — e.g. "$$" alone in one
    // paragraph and "1. (x^2 - 5x + 6)" in a list item, with the closing
    // "$$" in a third node. KaTeX's auto-render only matches delimiters
    // that live in the same text node, so it silently gave up, leaving the
    // literal "$$" markers and un-rendered "x^2" visible in the chat — the
    // exact bug in the screenshot. Rendering to KaTeX HTML first and
    // stashing the result behind an atomic placeholder sidesteps that
    // entirely: Markdown can no longer split an equation it never sees.
    const cleanedMarkdown = normalizeHtmlTags(markdownText);
    const latexWrapped    = autoWrapBareLatex(cleanedMarkdown);
    const { text: mathMasked, mathBlocks } = extractMath(latexWrapped);
    const rawHtml         = marked.parse(mathMasked);
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
                 "xmlns", "encoding", "columnalign", "open", "data-math-id"],
    });

    // Swap the placeholder spans for the real, pre-rendered KaTeX markup.
    injectMath(bubbleEl, mathBlocks);

    // If the original markdown contained LaTeX, add a small collapsible
    // preview showing the raw LaTeX source so users can inspect it.
    try {
      if (mathBlocks.length) {
        const details = document.createElement("details");
        details.className = "latex-preview";
        const summary = document.createElement("summary");
        summary.textContent = "LaTeX source";
        const pre = document.createElement("pre");
        pre.textContent = mathBlocks.map((b) => b.source).join("\n\n");
        details.appendChild(summary);
        details.appendChild(pre);
        bubbleEl.appendChild(details);
      }
    } catch (e) {
      // no-op if regex or DOM operations fail in edge cases
    }

    // Safety net: if window.katex wasn't ready yet when extractMath ran
    // (script race on the very first chunk), fall back to auto-render so
    // math still shows up once KaTeX finishes loading.
    renderLatexInto(bubbleEl);
  }

  /**
   * Finds every LaTeX expression in raw markdown text — $$...$$, $...$,
   * \[...\], \(...\) — and pre-renders each one to KaTeX HTML via
   * katex.renderToString, replacing it in the text with a small inert
   * placeholder span. This must run *before* marked.parse so Markdown's
   * block/list parser never gets a chance to split a single equation
   * across multiple elements (see FIX 7 above for why that mattered).
   *
   * Code spans and fenced code blocks are masked out first so a literal
   * "$" inside a code sample (shell prompts, variable names, etc.) is
   * never mistaken for math.
   */
  function extractMath(text) {
    const mathBlocks = [];
    if (!window.katex || typeof window.katex.renderToString !== "function") {
      return { text, mathBlocks };
    }

    // Temporarily pull out fenced code blocks and inline code so their
    // contents are never treated as math.
    const codeStash = [];
    let masked = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => {
      const idx = codeStash.push(m) - 1;
      return `\u0000CODE${idx}\u0000`;
    });

    const mathPattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^\n$]+?)\$/g;

    const renderClause = (source, isDisplay) => {
      let html;
      try {
        html = window.katex.renderToString(source, { displayMode: isDisplay, throwOnError: false });
      } catch (err) {
        return null; // leave the raw text if KaTeX chokes on it
      }
      const id = mathBlocks.length;
      mathBlocks.push({ id, source, display: isDisplay, html });
      return `<span class="math-placeholder" data-math-id="${id}"></span>`;
    };

    masked = masked.replace(mathPattern, (match, dollarDisplay, bracketDisplay, parenInline, dollarInline) => {
      const isDisplay = dollarDisplay !== undefined || bracketDisplay !== undefined;
      const source = (dollarDisplay ?? bracketDisplay ?? parenInline ?? dollarInline ?? "").trim();
      if (!source) return match;

      // FIX 9: a $$...$$ (or $...$) span whose "math" actually contains
      // markdown bold/italic syntax isn't real LaTeX — it's prose that
      // ended up between math delimiters, whether from the model's own
      // output or from an earlier heuristic. This is the actual root
      // cause behind the screenshot: rendering a span like "**b)** f(x) =
      // x^2 + 1 is **not injective** ..." whole through KaTeX prints the
      // literal ** markers instead of letting Markdown bold them. Salvage
      // it: drop the outer delimiters, keep the prose/markdown as plain
      // text, and only convert the genuine equation-like clauses inside
      // (e.g. "f(x) = x^2 + 1", "y = 0") to inline math.
      if (MD_EMPHASIS_PATTERN.test(source)) {
        return source.replace(INLINE_CLAUSE_PATTERN, (clause) => {
          return renderClause(clause.trim(), false) || clause;
        });
      }

      return renderClause(source, isDisplay) || match;
    });

    // Put the protected code snippets back.
    masked = masked.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeStash[Number(i)]);

    return { text: masked, mathBlocks };
  }

  /**
   * Replaces each `<span data-math-id="N">` placeholder left by
   * extractMath() with its real, pre-rendered KaTeX HTML. The HTML is
   * trusted here because it was generated locally by katex.renderToString,
   * not injected verbatim from the model's output.
   */
  function injectMath(bubbleEl, mathBlocks) {
    if (!mathBlocks || !mathBlocks.length) return;
    mathBlocks.forEach(({ id, html }) => {
      const placeholder = bubbleEl.querySelector(`[data-math-id="${id}"]`);
      if (placeholder) placeholder.outerHTML = html;
    });
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
    // FIX 9b: tracks whether we're inside a multi-line "$$" ... "$$" block
    // the model already wrote itself (an opening "$$" alone on its own
    // line, closed by a later standalone "$$"). Lines inside that block
    // must NOT go through the per-line FIX-8 logic below — doing so
    // double-wrapped inner clauses in their own "$...$", and since
    // extractMath() later salvages the *whole* multi-line span at once,
    // those inner "$" characters ended up as stray literal text instead of
    // being consumed as delimiters. Content inside an explicit multi-line
    // block is left completely untouched here; extractMath() handles it.
    let inMathBlock = false;
    const fencedPattern    = /^(```|~~~)/;
    const latexLinePattern = /\\[A-Za-z]+|\^\{?|_[A-Za-z0-9{]|\\(?:frac|sqrt|Rightarrow|Leftarrow|implies|rightarrow|leftarrow|cdot|times|pm|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|nu|pi|sigma|phi|omega|sum|int|lim|infty|le|ge|neq)\b/;

    // FIX 8: a line like "**b)** f(x) = x^2 + 1 is **not injective** (e.g.,
    // f(1) = f(-1) = 2) and **not surjective** (e.g., y = 0 has no
    // pre-image)." was being swallowed *whole* into one $$...$$ block just
    // because it contained a LaTeX-ish fragment like "x^2". KaTeX then
    // rendered the literal "**b)**" / "**not injective**" markers as plain
    // text instead of letting Markdown turn them into bold — the exact bug
    // in the screenshot. A line containing markdown bold/italic markers is
    // now left for Markdown to handle; only the specific equation-like
    // clauses inside it (e.g. "f(x) = x^2 + 1", "y = 0") get wrapped in
    // inline $...$ math, everything else — including the ** markers — is
    // untouched.
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

      // A standalone "$$" (or "$") line toggles whether we're inside an
      // explicit multi-line math block the model wrote itself.
      if (trimmed === "$$" || trimmed === "$") {
        inMathBlock = !inMathBlock;
        result.push(line);
        continue;
      }
      if (inMathBlock) {
        // Leave content inside an explicit block untouched — see FIX 9b.
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

      // Mixed prose + markdown-formatted line: don't swallow the whole
      // thing into math (see FIX 8). Only wrap the equation-like clauses.
      if (MD_EMPHASIS_PATTERN.test(line)) {
        if (latexLinePattern.test(line) && !/\$/.test(line)) {
          const wrapped = line.replace(INLINE_CLAUSE_PATTERN, (clause) => `$${clause.trim()}$`);
          result.push(wrapped);
        } else {
          result.push(line);
        }
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