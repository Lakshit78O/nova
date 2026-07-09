// Node test to emulate the chat.js render pipeline using jsdom
const { JSDOM } = require("jsdom");
const DOMPurify = require("dompurify");
const marked = require("marked");
const renderMathInElement = require("katex/contrib/auto-render").renderMathInElement;
const katex = require("katex");

function normalizeHtmlTags(markdownText) {
  let text = markdownText;
  text = text.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  text = text.replace(/<\s*(?:p|div|section|article|blockquote|h[1-6]|ul|ol|li|table|tr|td|th)[^>]*>/gi, "\n");
  text = text.replace(/<\s*\/\s*(?:p|div|section|article|blockquote|h[1-6]|ul|ol|li|table|tr|td|th)\s*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/\r\n?/g, "\n");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/[ \t]+\n/g, "\n");
  return text.trim();
}

function autoWrapBareLatex(markdownText) {
  const lines = markdownText.split("\n");
  let inFence = false;
  const fencedPattern = /^(```|~~~)/;
  const latexLinePattern = /\\[A-Za-z]+|\^\{|_[A-Za-z0-9{]|\\(?:frac|sqrt|Rightarrow|Leftarrow|implies|rightarrow|leftarrow|cdot|times|pm|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|nu|pi|sigma|phi|omega|sum|int|lim|infty|le|ge|neq)\b/;

  const result = [];
  for (const line of lines) {
    if (fencedPattern.test(line)) {
      inFence = !inFence;
      result.push(line);
      continue;
    }
    if (inFence) { result.push(line); continue; }
    const trimmed = line.trim();
    if (!trimmed) { result.push(line); continue; }
    if (trimmed.startsWith("$$") || trimmed.startsWith("$") || trimmed.startsWith("\\(") || trimmed.startsWith("\\[")) {
      result.push(line); continue;
    }
    if (latexLinePattern.test(line) && !/\$/.test(line)) {
      const cleaned = trimmed.replace(/\\\s*$/, "");
      result.push(`\n$$\n${cleaned}\n$$\n`);
      continue;
    }
    result.push(line);
  }
  return result.join("\n");
}

async function runTest() {
  const sample = `Here is a math question:\nIn a right-angled triangle, if the opposite side to angle $\\theta$ is 8 cm and the hypotenuse is 17 cm, find $\\sin\\theta$.`;

  const cleaned = normalizeHtmlTags(sample);
  const wrapped = autoWrapBareLatex(cleaned);
  const rawHtml = marked.parse(wrapped);

  const dom = new JSDOM(`<!doctype html><html><body><div id="out"></div></body></html>`);
  const window = dom.window;
  const purify = DOMPurify(window);

  const sanitized = purify.sanitize(rawHtml, {
    ADD_TAGS: ["math","mrow","mi","mo","mn","msup","msub","mfrac","munder","mover","munderover","msqrt","mtable","mtr","mtd","annotation","semantics","span"],
    ADD_ATTR: ["target","class","style","aria-hidden","role","xmlns","encoding","columnalign"],
  });

  const container = window.document.getElementById('out');
  container.innerHTML = sanitized;

  // Before KaTeX
  console.log('--- Sanitized HTML before KaTeX ---');
  console.log(container.innerHTML);

  // Run a direct math replacement using katex.renderToString(). This
  // mirrors what auto-render would do in the browser, suitable for node.
  const htmlBefore = container.innerHTML;
  const mathRe = /\$\$([\s\S]+?)\$\$|\$([^\n$]+?)\$/g;
  const htmlAfter = htmlBefore.replace(mathRe, (match, display, inline) => {
    const src = (display || inline || "").trim();
    const displayMode = Boolean(display);
    try {
      return katex.renderToString(src, { displayMode, throwOnError: false });
    } catch (e) {
      return match;
    }
  });

  container.innerHTML = htmlAfter;
  console.log('\n--- HTML after KaTeX rendering ---');
  console.log(container.innerHTML);
}

runTest().catch(err => { console.error(err); process.exit(1); });
