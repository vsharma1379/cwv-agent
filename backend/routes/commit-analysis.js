const express = require("express");
const axios = require("axios");
const router = express.Router();

const GITLAB_BASE = "https://gitlab.infoedge.com/api/v4";
const PROJECT_PATH = "ambitionbox%2Fmonorepo-web-native";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODEX_DIFF_CHAR_LIMIT = 12000;
const CODEX_CONTEXT_RADIUS = 80;
const CODEX_FALLBACK_CONTEXT_LINES = 300;

function parseChangedNewLineRanges(diffText) {
  const ranges = [];
  const hunkRe = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/gm;
  let match;

  while ((match = hunkRe.exec(diffText || "")) !== null) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(count)) continue;

    ranges.push({
      start,
      end: count === 0 ? start : start + count - 1,
    });
  }

  return ranges;
}

function buildCodexFileContext(fileText, diffText, radius = CODEX_CONTEXT_RADIUS) {
  if (typeof fileText !== "string" || !fileText) return "(could not fetch)";

  const lines = fileText.split("\n");
  const changedRanges = parseChangedNewLineRanges(diffText);

  if (!changedRanges.length) {
    return lines
      .slice(0, CODEX_FALLBACK_CONTEXT_LINES)
      .map((line, i) => `${i + 1}: ${line}`)
      .join("\n");
  }

  const mergedRanges = changedRanges
    .map(({ start, end }) => ({
      start: Math.max(1, start - radius),
      end: Math.min(lines.length, end + radius),
    }))
    .sort((a, b) => a.start - b.start)
    .reduce((acc, range) => {
      const prev = acc[acc.length - 1];
      if (prev && range.start <= prev.end + 1) {
        prev.end = Math.max(prev.end, range.end);
      } else {
        acc.push({ ...range });
      }
      return acc;
    }, []);

  return mergedRanges
    .map(({ start, end }) => {
      const body = lines
        .slice(start - 1, end)
        .map((line, i) => `${start + i}: ${line}`)
        .join("\n");

      return `--- lines ${start}-${end} ---\n${body}`;
    })
    .join("\n\n");
}

const CLS_PATTERNS = [
  {
    id: "img-no-dimensions",
    matches: (line) =>
      /<img\b/i.test(line) && !/(width|height)\s*=/i.test(line),
    description: "Image without explicit dimensions",
    detail:
      "Browser cannot pre-allocate space before the image loads. When the image arrives it shifts everything below it down.",
    fix:
      "Add explicit width and height attributes so the browser reserves the exact space before the image loads.",
    fixCode: {
      before: '<img src="/images/hero.jpg" alt="Hero">',
      after:
        '<img src="/images/hero.jpg" alt="Hero" width="1200" height="600">',
    },
    severity: "high",
  },
  {
    id: "font-display-missing",
    matches: (line) => /@font-face/i.test(line),
    description: "@font-face without font-display strategy",
    detail:
      "Without font-display the browser blocks text rendering until the font loads (FOIT), then reflows the layout when it swaps in (FOUT).",
    fix:
      "Add font-display: optional to @font-face — the browser uses the fallback font if the web font is not cached, eliminating the shift.",
    fixCode: {
      before:
        '@font-face {\n  font-family: "MyFont";\n  src: url("/fonts/myfont.woff2");\n}',
      after:
        '@font-face {\n  font-family: "MyFont";\n  src: url("/fonts/myfont.woff2");\n  font-display: optional;\n}',
    },
    severity: "medium",
  },
  {
    id: "dom-prepend-insert",
    matches: (line) =>
      /\.(prepend|insertBefore|insertAdjacentHTML|insertAdjacentElement)\s*\(/.test(
        line,
      ),
    description: "DOM insertion before existing content",
    detail:
      "Inserting elements before existing content pushes everything below it down. Common pattern: injecting a banner or cookie bar after the page has rendered.",
    fix:
      "Reserve the space in the initial HTML with a placeholder so existing content does not move when the dynamic content loads.",
    fixCode: {
      before:
        "// Injects banner at top — shifts page content down\ncontainer.prepend(bannerEl)",
      after:
        '// Reserve space first in HTML: <div id="banner-slot" style="min-height:60px"></div>\n// Then fill it — nothing shifts\ndocument.getElementById("banner-slot").appendChild(bannerEl)',
    },
    severity: "high",
  },
  {
    id: "document-write",
    matches: (line) => /document\.write\s*\(/.test(line),
    description: "document.write() usage",
    detail:
      "document.write() called after initial parse causes a full reflow. It also blocks the HTML parser until it completes.",
    fix: "Replace with DOM API calls that do not cause full-page reflow.",
    fixCode: {
      before:
        "document.write('<script src=\"https://cdn.example.com/lib.js\"></script>')",
      after:
        'const s = document.createElement("script");\ns.src = "https://cdn.example.com/lib.js";\ns.async = true;\ndocument.head.appendChild(s);',
    },
    severity: "high",
  },
  {
    id: "lazy-no-dimensions",
    matches: (line) =>
      /loading\s*=\s*["']lazy["']/i.test(line) &&
      !/(width|height)\s*=/i.test(line),
    description: "Lazy-loaded image without dimensions",
    detail:
      "Lazy images without dimensions have 0 height until they enter the viewport. When they load, they push content down — often causing a large CLS event mid-scroll.",
    fix: 'Always pair loading="lazy" with explicit width and height.',
    fixCode: {
      before: '<img loading="lazy" src="/photo.jpg" alt="...">',
      after:
        '<img loading="lazy" src="/photo.jpg" alt="..." width="800" height="600">',
    },
    severity: "high",
  },
  {
    id: "dynamic-inline-size",
    matches: (line) =>
      /style\s*\+?=\s*[`'""][^`'"]*(?:height|width)\s*:/.test(line) ||
      /\.style\.(height|width)\s*=/.test(line),
    description: "Dynamic inline height/width set via JS",
    detail:
      "Changing element dimensions via JS after the page has rendered causes layout recalculation and shifts surrounding elements.",
    fix:
      "Reserve the space in CSS with a known min-height, or animate using transform/opacity which do not trigger layout.",
    fixCode: {
      before:
        '// Sets height after content loads — shifts content below\nel.style.height = content.scrollHeight + "px"',
      after:
        '/* In CSS: set a min-height that matches the expected content */\n.accordion-body { min-height: 120px; }\n/* Use CSS transitions; avoid resizing via JS */\nel.classList.add("expanded")',
    },
    severity: "medium",
  },
  {
    id: "media-no-dimensions",
    matches: (line) =>
      /<(video|iframe)\b/i.test(line) &&
      !/(width|height|aspect-ratio)/i.test(line),
    description: "Video / iframe without dimensions",
    detail:
      "Embedded media with no size is 0×0 until the browser receives its metadata. When it loads it expands and pushes everything below it.",
    fix:
      "Wrap in a container with a known aspect ratio so the space is reserved before the media loads.",
    fixCode: {
      before: '<iframe src="https://www.youtube.com/embed/abc"></iframe>',
      after:
        '<div style="position:relative; aspect-ratio:16/9">\n  <iframe src="https://www.youtube.com/embed/abc"\n    style="position:absolute;inset:0;width:100%;height:100%">\n  </iframe>\n</div>',
    },
    severity: "high",
  },
  {
    id: "position-change",
    matches: (line) => /position\s*:\s*(absolute|fixed|sticky)/i.test(line),
    description: "Positioned element added (absolute/fixed/sticky)",
    detail:
      "Absolute/sticky elements can unintentionally affect surrounding flow if their containing block is not set correctly.",
    fix:
      "Ensure the parent has position:relative to contain the positioned child. Verify it does not affect siblings.",
    fixCode: {
      before:
        ".toast { position: fixed; bottom: 0; } /* parent has no position — may shift content */",
      after:
        ".page-wrapper { position: relative; } /* contain it */\n.toast { position: absolute; bottom: 0; }",
    },
    severity: "low",
  },
];

const INP_PATTERNS = [
  {
    id: "sync-xhr",
    matches: (line) => /\.open\s*\([^,]+,[^,]+,\s*false\s*\)/.test(line),
    description: "Synchronous XMLHttpRequest",
    detail:
      "Synchronous XHR freezes the main thread until the server responds. Any user interaction during that time is queued and cannot be processed — direct, guaranteed INP increase.",
    fix:
      "Replace with fetch() (async) or pass true as the third argument to open().",
    fixCode: {
      before:
        'const xhr = new XMLHttpRequest();\nxhr.open("GET", "/api/data", false); // false = synchronous\nxhr.send();\nconst result = xhr.responseText;',
      after:
        '// Option 1: fetch (preferred)\nconst res = await fetch("/api/data");\nconst result = await res.text();\n\n// Option 2: async XHR\nxhr.open("GET", "/api/data", true); // true = async',
    },
    severity: "high",
  },
  {
    id: "third-party-script",
    matches: (line) => /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i.test(line),
    description: "Third-party <script> tag added",
    detail:
      "A render-blocking third-party script downloads and executes on the main thread. During that time clicks queue up waiting. Even async scripts compete for CPU time.",
    fix:
      "Always add async or defer. Better: lazy-load the script only after the first user interaction.",
    fixCode: {
      before: '<script src="https://cdn.analytics.com/tracker.js"></script>',
      after:
        '<!-- Option 1: defer (runs after HTML parsed, before DOMContentLoaded) -->\n<script src="https://cdn.analytics.com/tracker.js" defer></script>\n\n<!-- Option 2: load on first interaction -->\n<script>\n  document.addEventListener("click", () => {\n    const s = document.createElement("script");\n    s.src = "https://cdn.analytics.com/tracker.js";\n    document.head.appendChild(s);\n  }, { once: true });\n</script>',
    },
    severity: "high",
  },
  {
    id: "forced-reflow",
    matches: (line) =>
      /\b(offsetWidth|offsetHeight|clientWidth|clientHeight|getBoundingClientRect|scrollTop|scrollLeft|innerText)\b/.test(
        line,
      ),
    description: "Layout-forcing property read (forced reflow)",
    detail:
      "Reading layout properties like offsetHeight forces the browser to flush all pending style changes and recalculate the entire layout synchronously. Inside an event handler this directly adds to INP.",
    fix:
      "Cache the value outside the handler so the read happens once at mount, not on every click.",
    fixCode: {
      before:
        'btn.addEventListener("click", () => {\n  const h = panel.offsetHeight; // forces reflow on every click\n  animate(h);\n});',
      after:
        '// Cache once at mount — no reflow on click\nlet panelHeight = panel.offsetHeight;\nnew ResizeObserver(([e]) => { panelHeight = e.contentRect.height; }).observe(panel);\n\nbtn.addEventListener("click", () => {\n  animate(panelHeight); // uses cached value\n});',
    },
    severity: "medium",
  },
  {
    id: "interaction-listener",
    matches: (line) =>
      /addEventListener\s*\(\s*["'](click|keydown|keyup|mousedown|pointerdown|touchstart)["']/.test(
        line,
      ),
    description: "New interaction event listener added",
    detail:
      "Any synchronous work inside a click/key handler runs during the interaction window and delays INP. This flags that a new handler was added — inspect its body for heavy operations.",
    fix:
      "Keep the handler body under 50ms. Defer non-visual work with requestIdleCallback or a Web Worker.",
    fixCode: {
      before:
        'btn.addEventListener("click", () => {\n  const data = processLargeArray(items); // blocks thread\n  render(data);\n});',
      after:
        'btn.addEventListener("click", () => {\n  render(cachedData); // show result immediately\n  requestIdleCallback(() => {\n    cachedData = processLargeArray(items); // heavy work deferred\n  });\n});',
    },
    severity: "medium",
  },
  {
    id: "localstorage-access",
    matches: (line) => /localStorage\.(get|set)Item/.test(line),
    description: "Synchronous localStorage access",
    detail:
      "localStorage I/O is synchronous and can block for 10–50ms on low-end devices with full storage. Frequent setItem calls inside handlers compound this.",
    fix:
      "Cache values in a JS variable at startup. Batch writes using debounce so they do not happen on every keystroke/click.",
    fixCode: {
      before:
        'input.addEventListener("input", (e) => {\n  localStorage.setItem("draft", e.target.value); // blocks on every keystroke\n});',
      after:
        'let draft = localStorage.getItem("draft") ?? ""; // read once at startup\n\nconst flush = debounce(() => localStorage.setItem("draft", draft), 1000);\n\ninput.addEventListener("input", (e) => {\n  draft = e.target.value; // instant in-memory update\n  flush(); // write deferred\n});',
    },
    severity: "low",
  },
  {
    id: "settimeout-zero",
    matches: (line) => /setTimeout\s*\([^,]+,\s*0\s*\)/.test(line),
    description: "setTimeout(fn, 0) deferral pattern",
    detail:
      "setTimeout(fn, 0) runs in the next task — it does yield to the browser for one paint, but if there are multiple chained 0ms timeouts they still add up inside the interaction window.",
    fix:
      "Use requestIdleCallback for truly background work, or scheduler.postTask with a low priority.",
    fixCode: {
      before:
        'btn.addEventListener("click", () => {\n  setTimeout(() => processMetrics(), 0);\n});',
      after:
        'btn.addEventListener("click", () => {\n  // Truly yields to browser; runs when idle\n  requestIdleCallback(() => processMetrics());\n  // Or with priority control:\n  // scheduler.postTask(() => processMetrics(), { priority: "background" });\n});',
    },
    severity: "low",
  },
  {
    id: "react-state-cascade",
    matches: (line) => /\bset[A-Z]\w+\s*\(/.test(line),
    description: "React state setter call",
    detail:
      "Multiple setState calls in a single handler cause sequential re-renders in React < 18. Each re-render takes CPU time that extends the interaction window.",
    fix:
      "Use React 18 (automatic batching) or consolidate multiple state updates into a single useReducer dispatch.",
    fixCode: {
      before:
        "// React 17: each setState triggers a separate re-render\nhandleClick = () => {\n  setLoading(true);\n  setError(null);\n  setData([]);\n}",
      after:
        '// Option 1: React 18 — batched automatically inside event handlers\n// Option 2: useReducer — single dispatch = single render\ndispatch({ type: "FETCH_START" })\n// reducer sets loading, error, data in one go',
    },
    severity: "low",
  },
  {
    id: "dom-query-in-handler",
    matches: (line) => /querySelectorAll\s*\(|getElementsBy/.test(line),
    description: "Full DOM query (may run on every interaction)",
    detail:
      "querySelectorAll walks the entire DOM every time it runs. On large pages (AmbitionBox review pages can have 100+ cards) this is expensive inside a click handler.",
    fix:
      "Cache the NodeList at component mount. Re-query only when the DOM actually changes (use MutationObserver).",
    fixCode: {
      before:
        'btn.addEventListener("click", () => {\n  const cards = document.querySelectorAll(".review-card"); // walks entire DOM on click\n  cards.forEach(highlight);\n});',
      after:
        '// Cache at mount, not on every click\nlet cards = document.querySelectorAll(".review-card");\n\nnew MutationObserver(() => {\n  cards = document.querySelectorAll(".review-card"); // refresh only when DOM changes\n}).observe(list, { childList: true });\n\nbtn.addEventListener("click", () => cards.forEach(highlight));',
    },
    severity: "low",
  },
  {
    id: "json-serialise",
    matches: (line) => /JSON\.(parse|stringify)/.test(line),
    description: "JSON.parse / JSON.stringify call",
    detail:
      "Serialising large objects on the main thread is blocking. On mobile, JSON.stringify of a 1MB object can take 30–100ms.",
    fix:
      "Move large serialisation work to a Web Worker. Avoid in hot interaction paths.",
    fixCode: {
      before:
        'saveBtn.addEventListener("click", () => {\n  const payload = JSON.stringify(largeFormData); // blocks main thread\n  sendToServer(payload);\n});',
      after:
        '// Offload to Web Worker\nconst worker = new Worker("/workers/serialise.js");\n\nsaveBtn.addEventListener("click", () => {\n  worker.postMessage({ action: "stringify", data: largeFormData });\n});\nworker.onmessage = (e) => sendToServer(e.data);',
    },
    severity: "low",
  },

  // ── Passive listeners ────────────────────────────────────────────────────
  {
    id: "non-passive-scroll-listener",
    matches: (line) =>
      /addEventListener\s*\(\s*["'](scroll|touchstart|touchmove|wheel|pointerdown)["']/.test(
        line,
      ) && !/passive\s*:\s*true/.test(line),
    description: "Scroll / touch listener without { passive: true }",
    detail:
      "Without passive:true the browser must wait for the JS handler to finish before it can scroll the page. This is one of the top INP killers on mobile — every scroll frame is blocked by your handler.",
    fix:
      "Add { passive: true } as the third argument. If you call e.preventDefault() inside, remove that call and use CSS touch-action instead.",
    fixCode: {
      before:
        "el.addEventListener('touchstart', onTouch)\nel.addEventListener('scroll', onScroll)",
      after:
        "el.addEventListener('touchstart', onTouch, { passive: true })\nel.addEventListener('scroll', onScroll, { passive: true })",
    },
    severity: "high",
  },

  // ── preventDefault on scroll / touch ────────────────────────────────────
  {
    id: "prevent-default-touch",
    matches: (line) => /\.preventDefault\s*\(\s*\)/.test(line),
    description: "preventDefault() — may block scroll / touch optimisation",
    detail:
      "Calling preventDefault() on touchstart / touchmove forces the browser to wait for JS before rendering the next scroll frame. This directly degrades INP on scroll-heavy pages like review feeds.",
    fix:
      "Remove preventDefault() from scroll/touch handlers where not strictly needed. Use CSS touch-action: pan-y or touch-action: none to control behaviour instead.",
    fixCode: {
      before:
        "el.addEventListener('touchmove', (e) => {\n  e.preventDefault(); // blocks scroll — forces layout wait\n  customScroll(e);\n})",
      after:
        "/* CSS approach — no JS blocking */\n.scroll-area { touch-action: pan-y; }\n\n/* Only call preventDefault where truly essential: */\nel.addEventListener('touchmove', customScroll, { passive: false }) // explicit opt-in",
    },
    severity: "high",
  },

  // ── setInterval for rendering ────────────────────────────────────────────
  {
    id: "setinterval-render",
    matches: (line) => /setInterval\s*\(/.test(line),
    description: "setInterval() — competes with user interactions",
    detail:
      "setInterval fires continuously even when the browser is busy responding to clicks. Rapid intervals doing DOM work steal the main thread and delay interaction response.",
    fix:
      "Use requestAnimationFrame for visual updates. Use a self-rescheduling setTimeout for polling so it does not fire on hidden tabs.",
    fixCode: {
      before:
        "setInterval(() => updateProgressBar(), 16) // fires 60×/s, competes with clicks",
      after:
        "function loop() {\n  updateProgressBar();\n  requestAnimationFrame(loop); // pauses on hidden tab, synced to display refresh\n}\nrequestAnimationFrame(loop)",
    },
    severity: "medium",
  },

  // ── dangerouslySetInnerHTML ──────────────────────────────────────────────
  {
    id: "dangerous-inner-html",
    matches: (line) => /dangerouslySetInnerHTML/.test(line),
    description: "dangerouslySetInnerHTML bypasses React diffing",
    detail:
      "React cannot diff raw HTML — it destroys and rebuilds the entire subtree on every render. Inside a frequently-updating component this causes heavy parsing + layout work on interactions.",
    fix:
      "Replace with React children. If you must use it, wrap in React.memo and memoize the HTML object so it only re-parses when content truly changes.",
    fixCode: {
      before: "<div dangerouslySetInnerHTML={{ __html: content }} />",
      after:
        "// Memoize so it only re-parses when content changes\nconst html = useMemo(() => ({ __html: content }), [content]);\n<div dangerouslySetInnerHTML={html} />\n\n// Better: parse server-side and render as React nodes",
    },
    severity: "medium",
  },

  // ── flushSync ────────────────────────────────────────────────────────────
  {
    id: "flush-sync",
    matches: (line) => /flushSync\s*\(/.test(line),
    description:
      "ReactDOM.flushSync() forces synchronous render in interaction",
    detail:
      "flushSync bypasses React 18 batching and forces an immediate synchronous render. If called inside a click handler it adds the full render cost to the interaction window — direct INP increase.",
    fix:
      "Remove flushSync — React 18 batches updates automatically. Only keep it if you must read updated DOM immediately after setState (rare).",
    fixCode: {
      before:
        "btn.addEventListener('click', () => {\n  flushSync(() => setCount(c + 1)); // synchronous render blocks thread\n  console.log(ref.current.textContent); // reads updated DOM\n})",
      after:
        "// React 18: batching is automatic inside event handlers\nbtn.addEventListener('click', () => setCount(c + 1));\n// Read updated DOM in a useEffect or callback ref instead",
    },
    severity: "high",
  },

  // ── eval / new Function ──────────────────────────────────────────────────
  {
    id: "eval-usage",
    matches: (line) =>
      /\beval\s*\(/.test(line) || /new\s+Function\s*\(/.test(line),
    description: "eval() or new Function() deoptimises V8",
    detail:
      "eval() and new Function() prevent V8 from compiling the surrounding scope to optimised machine code. They trigger deoptimisation that can slow all JS execution in that module.",
    fix:
      "Replace with a lookup table, JSON.parse for data, or a templating library.",
    fixCode: {
      before: "const result = eval(`handlers.${eventName}()`)",
      after:
        "const handlers = { click: handleClick, hover: handleHover };\nconst result = handlers[eventName]?.()",
    },
    severity: "high",
  },

  // ── Input handler without debounce ──────────────────────────────────────
  {
    id: "input-no-debounce",
    matches: (line) =>
      /addEventListener\s*\(\s*["'](input|keyup|keypress)["']/.test(line),
    description: "Input / keyup listener — verify it is debounced",
    detail:
      "Input handlers fire on every keystroke. If the handler does anything expensive (API call, heavy filtering, state update) it adds that cost to INP for every key the user presses.",
    fix:
      "Debounce the expensive work (150–300ms for search, 50ms for validation). Keep immediate UI feedback (showing typed text) outside the debounce.",
    fixCode: {
      before:
        "input.addEventListener('input', (e) => {\n  fetchSuggestions(e.target.value); // runs on EVERY keystroke\n})",
      after:
        "const debouncedFetch = debounce(fetchSuggestions, 200);\ninput.addEventListener('input', (e) => debouncedFetch(e.target.value))",
    },
    severity: "medium",
  },

  // ── innerHTML assignment ─────────────────────────────────────────────────
  {
    id: "innerhtml-assignment",
    matches: (line) => /\.innerHTML\s*[+]?=\s*/.test(line),
    description: "innerHTML assignment forces parse + layout",
    detail:
      "Assigning to innerHTML destroys existing DOM nodes, parses raw HTML, constructs new nodes, recalculates styles, and lays out the subtree — all synchronously. Inside an event handler this is a major INP contributor.",
    fix:
      "Use document.createElement + appendChild, or textContent for plain text. In React, render JSX instead.",
    fixCode: {
      before: "container.innerHTML += `<div class='card'>${data.title}</div>`",
      after:
        "const card = document.createElement('div');\ncard.className = 'card';\ncard.textContent = data.title; // safe, no HTML parse\ncontainer.appendChild(card)",
    },
    severity: "medium",
  },

  // ── CSS transition on layout properties ─────────────────────────────────
  {
    id: "css-layout-transition",
    matches: (line) =>
      /transition\s*:.*\b(width|height|top|left|right|bottom|padding|margin)\b/.test(
        line,
      ) ||
      /transition-property\s*:.*\b(width|height|top|left|right|bottom)\b/.test(
        line,
      ),
    description: "CSS transition on layout-triggering property",
    detail:
      "Animating width/height/top/left triggers layout recalculation on every animation frame. This runs on the main thread and competes with user interactions, raising INP particularly on low-end devices.",
    fix:
      "Use transform and opacity for animations — they run on the GPU compositor thread without touching layout.",
    fixCode: {
      before:
        "/* Triggers layout on every frame */\n.drawer { transition: width 0.3s ease; }\n.open  { width: 300px; }",
      after:
        "/* GPU compositor only — zero layout cost */\n.drawer { transform: translateX(-300px); transition: transform 0.3s ease; }\n.open  { transform: translateX(0); }",
    },
    severity: "medium",
  },

  // ── React Context with inline object ────────────────────────────────────
  {
    id: "react-context-inline-object",
    matches: (line) => /\bvalue\s*=\s*\{\{/.test(line),
    description: "React Context.Provider with inline object value",
    detail:
      "An inline object literal creates a new reference on every parent render, causing ALL context consumers to re-render — even if the actual data did not change. On interactions that trigger parent renders this cascades into heavy re-render work.",
    fix:
      "Memoize the context value with useMemo so consumers only re-render when the data actually changes.",
    fixCode: {
      before:
        "<UserContext.Provider value={{ user, setUser }}>\n  {children}\n</UserContext.Provider>",
      after:
        "const ctx = useMemo(() => ({ user, setUser }), [user, setUser]);\n\n<UserContext.Provider value={ctx}>\n  {children}\n</UserContext.Provider>",
    },
    severity: "medium",
  },

  // ── window.location hard navigation ─────────────────────────────────────
  {
    id: "window-location-change",
    matches: (line) => /window\.location\.(href|assign|replace)\s*=/.test(line),
    description: "Hard navigation via window.location",
    detail:
      "window.location.href triggers a full page unload and reload. The browser discards all cached state and must re-parse HTML, re-execute JS, and repaint from scratch — users see a blank screen.",
    fix:
      "Use the History API or a client-side router (Next.js Router / React Router) for soft navigation.",
    fixCode: {
      before:
        "btn.addEventListener('click', () => {\n  window.location.href = '/company/reviews'; // full reload\n})",
      after:
        "// Next.js\nconst router = useRouter();\n<button onClick={() => router.push('/company/reviews')}>\n\n// Vanilla\n<button onClick={() => history.pushState({}, '', '/company/reviews')}>",
    },
    severity: "medium",
  },

  // ── document.cookie ──────────────────────────────────────────────────────
  {
    id: "document-cookie",
    matches: (line) => /document\.cookie/.test(line),
    description: "Synchronous document.cookie access",
    detail:
      "Reading or writing document.cookie is synchronous and can block for several milliseconds, especially in cross-origin contexts where it triggers IPC calls to the browser process.",
    fix:
      "Cache cookie values in a JS variable at startup. Use the async CookieStore API where available.",
    fixCode: {
      before:
        "btn.addEventListener('click', () => {\n  const uid = document.cookie.match(/uid=([^;]+)/)?.[1]; // sync read on click\n})",
      after:
        "// Cache at startup — read once, use everywhere\nlet uid = document.cookie.match(/uid=([^;]+)/)?.[1];\n\nbtn.addEventListener('click', () => { /* use uid directly */ })",
    },
    severity: "low",
  },

  // ── Heavy observer callbacks ─────────────────────────────────────────────
  {
    id: "heavy-observer-callback",
    matches: (line) =>
      /new\s+(ResizeObserver|IntersectionObserver|MutationObserver)\s*\(/.test(
        line,
      ),
    description: "Observer created — verify callback is lightweight",
    detail:
      "Observer callbacks run in the browser rendering pipeline. Heavy work inside them (DOM queries, state updates, layout reads) blocks the next paint and degrades INP for nearby interactions.",
    fix:
      "Keep observer callbacks lightweight. Debounce rapid firings. Defer heavy work with requestIdleCallback.",
    fixCode: {
      before:
        "new ResizeObserver((entries) => {\n  entries.forEach(e => recomputeLayout(e)); // heavy work in observer\n}).observe(el)",
      after:
        "const onResize = debounce((entries) => {\n  entries.forEach(e => recomputeLayout(e));\n}, 100);\n\nnew ResizeObserver(onResize).observe(el)",
    },
    severity: "low",
  },

  // ── Missing event listener cleanup ──────────────────────────────────────
  {
    id: "listener-no-cleanup",
    matches: (line) => /addEventListener\s*\(\s*["']/.test(line),
    description: "Event listener added — verify it is removed on unmount",
    detail:
      "Event listeners not removed on component unmount accumulate over navigation. Each stale listener fires on interaction, adding hidden work that degrades INP progressively.",
    fix:
      "Always return a cleanup function from useEffect that calls removeEventListener, or use AbortController.",
    fixCode: {
      before:
        "useEffect(() => {\n  window.addEventListener('resize', handleResize);\n  // no cleanup — leaks on unmount\n}, [])",
      after:
        "useEffect(() => {\n  window.addEventListener('resize', handleResize);\n  return () => window.removeEventListener('resize', handleResize); // cleanup\n}, [])",
    },
    severity: "medium",
  },

  // ── Unthrottled mousemove / pointermove ─────────────────────────────────
  {
    id: "unthrottled-mousemove",
    matches: (line) =>
      /addEventListener\s*\(\s*["'](mousemove|pointermove)["']/.test(line),
    description: "mousemove / pointermove listener — must be throttled",
    detail:
      "mousemove fires up to 60+ times per second. Any non-trivial work inside the handler (DOM updates, state changes, layout reads) saturates the main thread and raises INP for all interactions.",
    fix:
      "Throttle with requestAnimationFrame so the handler runs at most once per frame.",
    fixCode: {
      before:
        "el.addEventListener('mousemove', (e) => {\n  updateTooltipPosition(e); // fires 60×/s\n})",
      after:
        "let rafId;\nel.addEventListener('mousemove', (e) => {\n  cancelAnimationFrame(rafId);\n  rafId = requestAnimationFrame(() => updateTooltipPosition(e)); // once per frame\n})",
    },
    severity: "medium",
  },

  // ── Long task in promise chain ───────────────────────────────────────────
  {
    id: "await-in-click-handler",
    matches: (line) =>
      /async\s*\(.*\)\s*=>/.test(line) || /async\s+function/.test(line),
    description: "Async function — verify UI responds before await resolves",
    detail:
      "An async click handler that does heavy work before the first await will block the interaction thread. The browser cannot paint the response until the synchronous portion completes.",
    fix:
      "Show immediate UI feedback (loading state, optimistic update) before any await. Move heavy synchronous setup after the first await.",
    fixCode: {
      before:
        "btn.addEventListener('click', async () => {\n  const data = processHeavyData(items); // sync — blocks thread\n  const res = await fetch('/api', { body: JSON.stringify(data) });\n  render(res);\n})",
      after:
        "btn.addEventListener('click', async () => {\n  setLoading(true); // immediate UI feedback before any heavy work\n  await scheduler.yield(); // yield to browser so loading state paints\n  const data = processHeavyData(items);\n  const res = await fetch('/api', { body: JSON.stringify(data) });\n  render(res);\n  setLoading(false);\n})",
    },
    severity: "medium",
  },

  // ── Large Array operations ───────────────────────────────────────────────
  {
    id: "large-array-sort",
    matches: (line) => /\.(sort|filter|map|reduce)\s*\(/.test(line),
    description:
      "Array sort / filter / map / reduce — verify not on large dataset in handler",
    detail:
      "Sorting or mapping thousands of items synchronously on the main thread inside a click handler directly adds to INP. A sort of 10k objects can take 50–200ms on mobile.",
    fix:
      "Pre-sort/filter data when it loads, not on interaction. Cache results with useMemo. For very large datasets, offload to a Web Worker.",
    fixCode: {
      before:
        "btn.addEventListener('click', () => {\n  const sorted = reviews.sort((a, b) => b.rating - a.rating); // sort 5000 items on click\n  render(sorted);\n})",
      after:
        "// Sort once when data loads, not on every click\nconst sorted = useMemo(() => [...reviews].sort((a, b) => b.rating - a.rating), [reviews]);\n\nbtn.onClick = () => render(sorted); // instant — already sorted",
    },
    severity: "low",
  },

  // ── Missing React.memo on large components ───────────────────────────────
  {
    id: "react-memo-missing",
    matches: (line) =>
      /export\s+default\s+function\s+[A-Z]/.test(line) &&
      !/memo\s*\(/.test(line),
    description: "React component exported without React.memo",
    detail:
      "Without React.memo, a component re-renders every time its parent renders — even if its props did not change. On interaction-triggered parent re-renders this cascades into unnecessary child work.",
    fix:
      "Wrap with React.memo for components that receive stable props. Use useCallback/useMemo to stabilise prop references.",
    fixCode: {
      before:
        "export default function ReviewCard({ review }) {\n  return <div>{review.text}</div>;\n}",
      after:
        "const ReviewCard = React.memo(function ReviewCard({ review }) {\n  return <div>{review.text}</div>;\n});\nexport default ReviewCard;",
    },
    severity: "low",
  },

  // ── Synchronous import() inside handler ─────────────────────────────────
  {
    id: "dynamic-import-in-handler",
    matches: (line) => /import\s*\(/.test(line),
    description: "Dynamic import() — may run inside interaction handler",
    detail:
      "import() inside a click handler forces a network round-trip before the interaction can complete. The user sees no response until the chunk downloads and executes.",
    fix:
      "Preload the chunk on hover/focus so it is already cached by the time the user clicks.",
    fixCode: {
      before:
        "btn.addEventListener('click', async () => {\n  const { Modal } = await import('./Modal'); // network wait blocks response\n  Modal.open();\n})",
      after:
        "// Preload on hover so chunk is cached before click\nbtn.addEventListener('mouseenter', () => import('./Modal'), { once: true });\n\nbtn.addEventListener('click', async () => {\n  const { Modal } = await import('./Modal'); // already cached — instant\n  Modal.open();\n})",
    },
    severity: "medium",
  },

  // ════════════════════════════════════════════════════════════════════════
  // BOTTOM SHEET / MODAL PATTERNS
  // ════════════════════════════════════════════════════════════════════════

  {
    id: "bottom-sheet-layout-animation",
    matches: (line) =>
      // animating height, bottom, top on something named sheet/modal/drawer
      (/transition\s*:.*\b(height|bottom|top)\b/.test(line) &&
        /\b(sheet|modal|drawer|panel|overlay)\b/i.test(line)) ||
      // or a keyframe animating these layout properties
      (/\b(height|bottom|top)\s*:/.test(line) && /@keyframes/.test(line)) ||
      // or direct style assignment of bottom/top in JS
      /\.style\.(bottom|top|height)\s*=/.test(line),
    description:
      "Bottom sheet / modal animated with layout-triggering property",
    detail:
      "Animating bottom, top, or height on a sheet/modal triggers layout recalculation on every frame of the animation. The browser cannot compositor-thread this — it blocks the main thread and makes every interaction during the open/close animation feel laggy.",
    fix:
      "Animate with transform: translateY() instead. The sheet starts off-screen at translateY(100%) and slides in to translateY(0) — pure GPU, zero layout cost.",
    fixCode: {
      before:
        "/* Layout-triggering — causes jank on every frame */\n.bottom-sheet {\n  position: fixed;\n  bottom: -100%;\n  transition: bottom 0.3s ease;\n}\n.bottom-sheet.open { bottom: 0; }",
      after:
        "/* GPU compositor only — silky smooth */\n.bottom-sheet {\n  position: fixed;\n  bottom: 0;\n  transform: translateY(100%); /* start off-screen */\n  transition: transform 0.3s ease;\n  will-change: transform;\n}\n.bottom-sheet.open { transform: translateY(0); }",
    },
    severity: "high",
  },

  {
    id: "body-scroll-lock",
    matches: (line) =>
      /document\.body\.style\.(overflow|position)\s*=/.test(line) ||
      /document\.documentElement\.style\.overflow\s*=/.test(line) ||
      /classList\.(add|remove)\s*\(\s*['"](?:overflow-hidden|no-scroll|modal-open|body-lock)['"]\s*\)/.test(
        line,
      ),
    description: "Body scroll lock (overflow:hidden) on sheet open",
    detail:
      "Setting overflow:hidden on <body> when a bottom sheet opens forces the browser to recalculate layout for the entire page. On a long review page this reflow can take 50–150ms — users feel the freeze the moment they tap to open the sheet.",
    fix:
      "Use overscroll-behavior: contain on the sheet itself so scroll does not escape, without touching body layout.",
    fixCode: {
      before:
        "// Sheet open handler — freezes page\nfunction openSheet() {\n  document.body.style.overflow = 'hidden'; // full-page reflow\n  sheet.classList.add('open');\n}",
      after:
        "/* CSS on the sheet itself — no body reflow needed */\n.bottom-sheet {\n  overflow-y: auto;\n  overscroll-behavior: contain; /* scroll stays inside */\n}\n\n// Open handler — no body mutation\nfunction openSheet() {\n  sheet.classList.add('open'); // only compositor work\n}",
    },
    severity: "high",
  },

  {
    id: "backdrop-filter-blur",
    matches: (line) => /backdrop-filter\s*:.*blur\s*\(/.test(line),
    description: "backdrop-filter: blur() on modal / overlay",
    detail:
      "Blurring everything behind a modal requires the browser to composite and blur the entire layer below it on every frame. On mid-range Android devices this alone can drop frame rate to under 20fps while the sheet is open, directly raising INP for any tap on the sheet content.",
    fix:
      "Replace with a semi-transparent solid overlay. If blur is a product requirement, limit it to a small fixed area and add will-change: backdrop-filter.",
    fixCode: {
      before:
        ".modal-backdrop {\n  backdrop-filter: blur(8px); /* GPU-heavy on mobile */\n  background: rgba(0,0,0,0.2);\n}",
      after:
        "/* Option 1: semi-transparent solid — zero GPU cost */\n.modal-backdrop { background: rgba(0,0,0,0.55); }\n\n/* Option 2: if blur is required — contain the cost */\n.modal-backdrop {\n  backdrop-filter: blur(4px);\n  will-change: backdrop-filter;\n  /* keep blur radius small */\n}",
    },
    severity: "high",
  },

  {
    id: "sheet-no-will-change",
    matches: (line) =>
      /position\s*:\s*fixed/.test(line) &&
      /\b(sheet|modal|drawer|panel|dialog|overlay|bottomsheet)\b/i.test(line),
    description: "Fixed-position sheet without will-change: transform",
    detail:
      "Without will-change, the browser promotes the sheet to its own GPU layer only when the animation starts, causing a stutter on the first open. Adding will-change: transform lets the browser prepare the layer in advance.",
    fix:
      "Add will-change: transform to the sheet CSS. Remove it after the sheet closes to free GPU memory.",
    fixCode: {
      before:
        ".bottom-sheet {\n  position: fixed;\n  bottom: 0;\n  transform: translateY(100%);\n  transition: transform 0.3s ease;\n  /* missing will-change — first open stutters */\n}",
      after:
        ".bottom-sheet {\n  position: fixed;\n  bottom: 0;\n  transform: translateY(100%);\n  transition: transform 0.3s ease;\n  will-change: transform; /* GPU layer ready before open */\n}\n/* Remove after close to free GPU memory: */\n.bottom-sheet.closed { will-change: auto; }",
    },
    severity: "medium",
  },

  {
    id: "sheet-heavy-on-open",
    matches: (line) =>
      // fetch or heavy state called inside a click handler that opens a sheet
      (/fetch\s*\(/.test(line) || /axios\.(get|post|put)\s*\(/.test(line)) &&
      /\b(open|show|toggle|visible|isOpen)\b/i.test(line),
    description: "Data fetch triggered on sheet open click",
    detail:
      "Fetching data the moment the sheet opens means the sheet animation and the network request compete for resources. The user taps → no immediate response → network completes → sheet renders. This is perceived as a slow click.",
    fix:
      "Show the sheet immediately with a skeleton/loading state, then fetch in the background. Or prefetch on hover before the tap.",
    fixCode: {
      before:
        "function handleOpenSheet() {\n  fetch('/api/reviews') // blocks immediate visual response\n    .then(res => res.json())\n    .then(data => { setReviews(data); setOpen(true); });\n}",
      after:
        "function handleOpenSheet() {\n  setOpen(true);    // immediate — sheet animates in with skeleton\n  setLoading(true);\n  fetch('/api/reviews')  // runs in background while sheet is animating\n    .then(res => res.json())\n    .then(data => { setReviews(data); setLoading(false); });\n}",
    },
    severity: "high",
  },

  {
    id: "sheet-swipe-no-passive",
    matches: (line) =>
      /addEventListener\s*\(\s*["'](touchstart|touchmove)["']/.test(line) &&
      !/passive\s*:\s*true/.test(line) &&
      /\b(sheet|drawer|swipe|drag|pull|dismiss)\b/i.test(line),
    description: "Swipe-to-dismiss gesture listener without passive:true",
    detail:
      "A swipe-to-close gesture on a bottom sheet that registers touchmove without passive:true blocks every scroll frame while the user is dragging. The browser cannot interpolate the swipe until your JS handler returns.",
    fix:
      "Add { passive: true } to the touch listeners. Track the swipe delta internally; only call preventDefault if the gesture crosses a threshold.",
    fixCode: {
      before:
        "sheet.addEventListener('touchmove', onDrag) // blocks scroll pipeline",
      after:
        "sheet.addEventListener('touchmove', onDrag, { passive: true })\n// Inside onDrag: check if delta crosses threshold before acting\n// Do NOT call e.preventDefault() in a passive listener",
    },
    severity: "high",
  },

  // ════════════════════════════════════════════════════════════════════════
  // SLOW CLICK PATTERNS
  // ════════════════════════════════════════════════════════════════════════

  {
    id: "div-click-300ms-delay",
    matches: (line) =>
      /<(div|span|li|td|tr|section|article)\b[^>]*\b(onClick|onclick)\b/i.test(
        line,
      ),
    description: "<div> / <span> with onClick — 300ms tap delay on mobile",
    detail:
      "Mobile browsers wait 300ms after a tap on non-button elements to check for a double-tap zoom gesture. Every click on a <div> or <span> with onClick is inherently 300ms slower on mobile unless touch-action: manipulation is set.",
    fix:
      "Use <button> for interactive elements — browsers apply touch-action: manipulation automatically. Or add touch-action: manipulation to the element's CSS.",
    fixCode: {
      before:
        '<div onClick={handleSelect} className="review-card">\n  {/* 300ms tap delay on mobile */}\n</div>',
      after:
        '// Option 1: use <button> (best — semantic + fast)\n<button onClick={handleSelect} className="review-card">\n\n// Option 2: keep div but kill the delay in CSS\n// .review-card { touch-action: manipulation; cursor: pointer; }',
    },
    severity: "high",
  },

  {
    id: "click-handler-no-feedback",
    matches: (line) =>
      /(onClick|addEventListener\s*\(\s*["']click["'])/.test(line) &&
      !/loading|disabled|pending|spinner|skeleton/i.test(line),
    description: "Click handler without immediate visual feedback",
    detail:
      "If a click handler does async work (fetch, navigation, heavy compute) without immediately updating the UI, the user sees no response for hundreds of milliseconds and assumes the tap did not register — leading to double-taps and frustration. This is an INP perception issue even if the handler technically finishes in time.",
    fix:
      "Always update UI state (disabled button, loading spinner, optimistic result) as the very first line of the click handler, before any await.",
    fixCode: {
      before:
        "async function handleSubmit() {\n  const res = await fetch('/api/submit', { method: 'POST', body });\n  setResult(await res.json()); // user sees nothing for 300–800ms\n}",
      after:
        "async function handleSubmit() {\n  setLoading(true);   // immediate — user knows tap registered\n  setError(null);\n  try {\n    const res = await fetch('/api/submit', { method: 'POST', body });\n    setResult(await res.json());\n  } finally {\n    setLoading(false);\n  }\n}",
    },
    severity: "medium",
  },

  {
    id: "click-settimeout-delay",
    matches: (line) =>
      /setTimeout\s*\(/.test(line) &&
      /(onClick|click|handleClick|onPress)\b/i.test(line),
    description: "setTimeout inside click handler",
    detail:
      "Adding an artificial delay inside a click handler is directly measurable as INP. Even a 0ms timeout adds task-switching overhead; anything higher is directly user-perceptible latency.",
    fix:
      "Remove the setTimeout. If it was added to let the browser repaint first, use await scheduler.yield() or requestAnimationFrame instead.",
    fixCode: {
      before:
        "function handleClick() {\n  setTimeout(() => {\n    doHeavyWork(); // artificial delay = artificial INP\n  }, 100);\n}",
      after:
        "async function handleClick() {\n  // Yield to browser so any pending paints flush first\n  await new Promise(r => requestAnimationFrame(r));\n  doHeavyWork();\n}",
    },
    severity: "medium",
  },

  {
    id: "click-propagation-stack",
    matches: (line) =>
      /(onClick|addEventListener\s*\(\s*["']click["'])/.test(line) &&
      !/stopPropagation/.test(line) &&
      /\b(card|item|row|tile|list)\b/i.test(line),
    description: "Click on list item / card without stopPropagation check",
    detail:
      "Click events bubble up the DOM. If a card has an onClick and a parent container also has an onClick, both handlers run on every tap. On a page with many cards (review list, company list) this compounds.",
    fix:
      "Call e.stopPropagation() where needed. Prefer event delegation on the container with a single handler rather than attaching onClick to every card.",
    fixCode: {
      before:
        "// Both handlers fire on every card tap\n<ul onClick={handleListClick}>\n  {items.map(i => <li onClick={handleItemClick}>{i.name}</li>)}\n</ul>",
      after:
        '// Single handler via event delegation\n<ul onClick={(e) => {\n  const li = e.target.closest("li");\n  if (li) handleItemClick(li.dataset.id);\n}}>\n  {items.map(i => <li data-id={i.id}>{i.name}</li>)}\n</ul>',
    },
    severity: "low",
  },

  {
    id: "touch-action-missing-interactive",
    matches: (line) =>
      /\b(clickable|tappable|interactive|pressable)\b/i.test(line) &&
      !/(touch-action|TouchableOpacity|TouchableHighlight|Pressable)\b/.test(
        line,
      ),
    description: "Interactive element without touch-action declaration",
    detail:
      "Without touch-action: manipulation, the browser reserves 300ms after every tap to detect double-tap-to-zoom. Explicitly declaring touch-action removes this delay.",
    fix:
      "Add touch-action: manipulation to all interactive non-button elements.",
    fixCode: {
      before:
        ".clickable-card { cursor: pointer; }\n/* Missing touch-action — 300ms delay on mobile */  ",
      after:
        ".clickable-card {\n  cursor: pointer;\n  touch-action: manipulation; /* removes 300ms tap delay */\n  -webkit-tap-highlight-color: transparent; /* removes blue flash on tap */\n}",
    },
    severity: "medium",
  },

  {
    id: "ripple-layout-trigger",
    matches: (line) =>
      /\b(ripple|ink|wave|splash)\b/i.test(line) &&
      /(width|height|transform|border-radius)\s*:/.test(line),
    description: "Ripple / ink effect — verify it does not trigger layout",
    detail:
      "Ripple animations that animate width/height of a pseudo-element trigger layout on every frame. This competes with click handler work and raises INP — particularly on cards with many ripples.",
    fix:
      "Animate transform: scale() and opacity on an absolutely-positioned ripple element instead of width/height.",
    fixCode: {
      before:
        '/* Layout-triggering ripple */\n.ripple::after {\n  content: "";\n  width: 0;\n  height: 0;\n  transition: width 0.4s, height 0.4s; /* layout per frame */\n}',
      after:
        '/* GPU-only ripple */\n.ripple::after {\n  content: "";\n  position: absolute;\n  width: 100%; height: 100%;\n  transform: scale(0);\n  opacity: 0.3;\n  border-radius: 50%;\n  transition: transform 0.4s, opacity 0.4s; /* compositor only */\n}\n.ripple:active::after { transform: scale(2); opacity: 0; }',
    },
    severity: "medium",
  },
];

const ALL_PATTERNS = [
  ...CLS_PATTERNS.map((p) => ({ ...p, metric: "CLS" })),
  ...INP_PATTERNS.map((p) => ({ ...p, metric: "INP" })),
];

function getGitLabHeaders() {
  const token = process.env.GITLAB_TOKEN;
  if (!token) throw new Error("GITLAB_TOKEN environment variable is not set");
  return { "PRIVATE-TOKEN": token };
}

// Takes the actual matched line from the repo diff and produces a concrete suggested fix.
// Returns null if no automatic transform is possible (frontend falls back to generic fixCode).
function suggestFix(patternId, line) {
  const trim = line.trim();

  switch (patternId) {
    // ── CLS ────────────────────────────────────────────────────────────────

    case "img-no-dimensions":
    case "lazy-no-dimensions": {
      // Insert width/height placeholders before the closing > or />
      const fixed = trim.replace(
        /(\s*\/?>)\s*$/,
        ' width="???" height="???"$1',
      );
      return fixed !== trim ? fixed : null;
    }

    case "font-display-missing":
      // Append font-display after the @font-face opening
      return trim.endsWith("{")
        ? trim + "\n  font-display: optional; /* ⚠ added */"
        : trim + " { font-display: optional; /* ⚠ add inside block */ }";

    case "dom-prepend-insert":
      return trim
        .replace(".prepend(", ".appendChild( /* ⚠ reserve space first */")
        .replace(
          ".insertBefore(",
          ".appendChild( /* ⚠ use append or reserve space */)",
        )
        .replace(
          /\.insertAdjacentHTML\s*\(\s*['"]beforebegin['"]/,
          ".insertAdjacentHTML('beforeend' /* ⚠ was beforebegin — caused shift */",
        );

    case "document-write":
      return `// ⚠ Replace this entire line with DOM API:\nconst s = document.createElement('script');\n// or: el.textContent = content;`;

    case "dynamic-inline-size": {
      const fixed = trim
        .replace(
          /\.style\.height\s*=\s*/,
          "/* ⚠ use CSS min-height */ .style.height = ",
        )
        .replace(
          /\.style\.width\s*=\s*/,
          "/* ⚠ use CSS aspect-ratio */ .style.width = ",
        );
      return fixed !== trim
        ? fixed
        : `/* ⚠ Set dimensions in CSS, not inline JS */\n// ${trim}`;
    }

    case "media-no-dimensions":
      return trim.replace(
        /(<(?:video|iframe)\b)/i,
        '$1 style="aspect-ratio:16/9;width:100%" /* ⚠ added */',
      );

    case "position-change":
      return (
        trim + " /* ⚠ verify parent has position:relative to contain this */"
      );

    // ── INP ────────────────────────────────────────────────────────────────

    case "sync-xhr":
      return `const res = await fetch(url); // replace sync XHR\nconst result = await res.text();`;

    case "third-party-script": {
      // Add async if not already present
      const fixed = trim.replace(
        /<script\b(?![^>]*\b(?:async|defer)\b)/i,
        "<script async",
      );
      return fixed !== trim ? fixed : trim + " /* ⚠ add async or defer */";
    }

    case "non-passive-scroll-listener": {
      const fixed = trim.replace(
        /(addEventListener\s*\(\s*["'][^'"]+["']\s*,\s*\S+)\s*\)\s*$/,
        "$1, { passive: true })",
      );
      return fixed !== trim
        ? fixed
        : trim + " /* ⚠ add { passive: true } as third arg */";
    }

    case "prevent-default-touch":
      return null; // location matters — can only be flagged, not auto-fixed

    case "setinterval-render": {
      // Try to transform the actual interval call
      const fixed = trim.replace(
        /setInterval\s*\((\s*(?:\(\)\s*=>|function\s*\(\s*\))\s*\{?[\s\S]*?)\s*,\s*\d+\s*\)/,
        "requestAnimationFrame(function loop() {\n  $1\n  requestAnimationFrame(loop);\n})",
      );
      return fixed !== trim ? fixed : null;
    }

    case "dangerous-inner-html": {
      // Try replacing with memoized version
      const fixed = trim.replace(
        /dangerouslySetInnerHTML=\{\{/,
        "dangerouslySetInnerHTML={memoizedHtml /* ⚠ useMemo(() => ({__html:...}), [content]) */",
      );
      return fixed !== trim
        ? fixed
        : trim + " /* ⚠ wrap in useMemo to avoid re-parse */";
    }

    case "flush-sync":
      // Remove the flushSync wrapper, keep the inner setState call
      return trim
        .replace(/flushSync\s*\(\s*\(\s*\)\s*=>\s*/, "")
        .replace(/\)\s*\)\s*;?\s*$/, ");");

    case "eval-usage":
      return null; // replacement depends entirely on what eval is doing

    case "input-no-debounce": {
      const fixed = trim.replace(
        /(addEventListener\s*\(\s*["'](?:input|keyup|keypress)["']\s*,\s*)(\w+)/,
        "$1debounce($2, 200) /* ⚠ wrap with debounce */",
      );
      return fixed !== trim
        ? fixed
        : trim + " /* ⚠ wrap handler with debounce(fn, 200) */";
    }

    case "innerhtml-assignment": {
      // Replace innerHTML = with textContent = for plain text cases
      const asText = trim.replace(/\.innerHTML\s*=\s*/, ".textContent = ");
      return asText !== trim ? asText : null;
    }

    case "css-layout-transition": {
      const fixed = trim
        .replace(
          /\btransition\s*:\s*([\w\s,]+\b)(width|height|top|left|right|bottom)\b([\w\s,]*)/,
          "transition: transform$3",
        )
        .replace(
          /\btransition-property\s*:\s*([\w\s,]*)\b(width|height|top|left|right|bottom)\b/,
          "transition-property: transform",
        );
      return fixed !== trim ? fixed : null;
    }

    case "react-context-inline-object": {
      const fixed = trim.replace(
        /\bvalue\s*=\s*\{\{/,
        "value={memoCtx /* useMemo */} /* was: value={{",
      );
      return fixed !== trim ? fixed : null;
    }

    case "window-location-change":
      return trim
        .replace(/window\.location\.href\s*=\s*/, "router.push(")
        .replace(/;$/, ");");

    case "document-cookie":
      return null; // highly context-dependent

    case "heavy-observer-callback": {
      const fixed = trim.replace(
        /new\s+(ResizeObserver|IntersectionObserver|MutationObserver)\s*\((\w+)\)/,
        "new $1(debounce($2, 100))",
      );
      return fixed !== trim ? fixed : null;
    }

    case "listener-no-cleanup":
      return null; // fix is in useEffect return, not on this line

    case "unthrottled-mousemove": {
      const fixed = trim.replace(
        /(addEventListener\s*\(\s*["'](?:mousemove|pointermove)["']\s*,\s*)(\w+)/,
        "$1(e) => requestAnimationFrame(() => $2(e)) /* ⚠ throttled via rAF */",
      );
      return fixed !== trim
        ? fixed
        : trim + " /* ⚠ throttle with requestAnimationFrame */";
    }

    case "large-array-sort":
      return null; // whether this is a problem depends on dataset size and call site

    case "react-state-cascade":
      return null; // single setState is fine — only a problem with many in one handler

    case "dynamic-import-in-handler": {
      const fixed = trim.replace(
        /await\s+import\s*\(/,
        "await import( /* ⚠ preload on mouseenter so this is cached */",
      );
      return fixed !== trim
        ? fixed
        : trim + " /* ⚠ preload on hover before click */";
    }

    // ── Bottom sheet ────────────────────────────────────────────────────────

    case "bottom-sheet-layout-animation":
      return (
        trim
          .replace(
            /\btransition\s*:\s*bottom\b/,
            "transition: transform /* ⚠ was: bottom */",
          )
          .replace(
            /\btransition\s*:\s*top\b/,
            "transition: transform /* ⚠ was: top */",
          )
          .replace(
            /\btransition\s*:\s*height\b/,
            "transition: transform /* ⚠ was: height */",
          )
          .replace(
            /\.style\.bottom\s*=/,
            '/* ⚠ use .style.transform = "translateY(...)" */ .style.bottom =',
          )
          .replace(
            /\.style\.top\s*=/,
            '/* ⚠ use .style.transform = "translateY(...)" */ .style.top =',
          ) +
        (trim.includes("transition")
          ? "\n/* ⚠ start sheet at transform:translateY(100%) and animate to translateY(0) */"
          : "")
      );

    case "body-scroll-lock":
      return trim
        .replace(
          /document\.body\.style\.overflow\s*=\s*['"]hidden['"]/,
          "/* remove */ document.body.style.overflow = 'hidden'",
        )
        .replace(
          /classList\.add\s*\(\s*['"](?:overflow-hidden|no-scroll|modal-open|body-lock)['"]\s*\)/,
          "classList.add(/* remove this — use CSS overscroll-behavior:contain on sheet instead */)",
        );

    case "backdrop-filter-blur": {
      const fixed = trim.replace(
        /blur\s*\(\s*(\d+)px\s*\)/i,
        (_, n) =>
          `blur(${Math.min(
            2,
            parseInt(n, 10),
          )}px) /* ⚠ reduced; consider rgba bg instead */`,
      );
      return fixed !== trim
        ? fixed
        : trim + " /* ⚠ replace with rgba background */";
    }

    case "sheet-no-will-change":
      return trim.replace(
        "position: fixed",
        "position: fixed;\n  will-change: transform; /* ⚠ added — GPU layer ready before open */",
      );

    case "sheet-heavy-on-open":
      return null; // restructuring async flow needs full handler context

    case "sheet-swipe-no-passive": {
      const fixed = trim.replace(
        /(addEventListener\s*\(\s*["'](?:touchstart|touchmove)["']\s*,\s*\S+)\s*\)\s*$/,
        "$1, { passive: true })",
      );
      return fixed !== trim ? fixed : trim + " /* ⚠ add { passive: true } */";
    }

    // ── Click patterns ──────────────────────────────────────────────────────

    case "div-click-300ms-delay": {
      const fixed = trim
        .replace(/<div\b/gi, "<button")
        .replace(/<span\b/gi, "<button");
      return fixed !== trim
        ? fixed +
            ' /* ⚠ changed div→button; add type="button" if not submitting */'
        : trim +
            " /* ⚠ add touch-action:manipulation to CSS class, or use <button> */";
    }

    case "click-handler-no-feedback":
      return null; // fix requires adding state above this line — needs full handler context

    case "click-settimeout-delay": {
      const fixed = trim.replace(
        /setTimeout\s*\((\s*(?:\(\)\s*=>|function\s*\(\s*\))\s*\{?[\s\S]*?)\s*,\s*\d+\s*\)/,
        "requestAnimationFrame($1)",
      );
      return fixed !== trim ? fixed : null;
    }

    case "click-propagation-stack":
      return null; // whether stopPropagation is needed depends on parent handlers

    case "touch-action-missing-interactive":
      return null; // fix is in CSS file, not on this line

    case "ripple-layout-trigger": {
      const fixed = trim
        .replace(/\bwidth\s*:\s*[\d.]+\w+/, "transform: scale(0)")
        .replace(/\bheight\s*:\s*[\d.]+\w+/, "opacity: 0");
      return fixed !== trim ? fixed : null;
    }

    default:
      return null;
  }
}

function getPatterns(metric) {
  if (metric === "cls")
    return CLS_PATTERNS.map((p) => ({ ...p, metric: "CLS" }));
  if (metric === "inp")
    return INP_PATTERNS.map((p) => ({ ...p, metric: "INP" }));
  return ALL_PATTERNS;
}

// Analyses the raw unified diff for a single file.
// Returns per-pattern findings that include surrounding context lines.
function analyzeDiff(rawDiff, metric) {
  const lines = (rawDiff || "").split("\n");
  const patterns = getPatterns(metric);
  const byPattern = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const content = line.slice(1);

    for (const pat of patterns) {
      if (!pat.matches(content)) continue;

      if (!byPattern[pat.id]) {
        byPattern[pat.id] = {
          id: pat.id,
          metric: pat.metric,
          description: pat.description,
          detail: pat.detail,
          fix: pat.fix,
          fixCode: pat.fixCode || null,
          severity: pat.severity,
          matchCount: 0,
          occurrences: [],
        };
      }

      byPattern[pat.id].matchCount++;

      // Store context + concrete suggestion for up to 3 occurrences
      if (byPattern[pat.id].occurrences.length < 3) {
        const start = Math.max(0, i - 4);
        const end = Math.min(lines.length - 1, i + 4);
        const context = [];
        for (let j = start; j <= end; j++) {
          const l = lines[j];
          const isAdded = l.startsWith("+") && !l.startsWith("+++");
          const isRemoved = l.startsWith("-") && !l.startsWith("---");
          context.push({
            text: l.slice(1).slice(0, 140),
            type: isAdded ? "added" : isRemoved ? "removed" : "context",
            isMatch: j === i,
          });
        }
        byPattern[pat.id].occurrences.push({
          context,
          matchedLine: content.trim().slice(0, 200),
          suggestedFix: suggestFix(pat.id, content),
        });
      }
    }
  }

  return Object.values(byPattern);
}

function riskScore(findings) {
  const w = { high: 3, medium: 2, low: 1 };
  return findings.reduce(
    (sum, f) => sum + (w[f.severity] || 1) * f.matchCount,
    0,
  );
}

function riskLevel(score) {
  if (score >= 8) return "high";
  if (score >= 4) return "medium";
  if (score > 0) return "low";
  return "none";
}

async function fetchMRInfo(commitId, headers) {
  try {
    const {
      data,
    } = await axios.get(
      `${GITLAB_BASE}/projects/${PROJECT_PATH}/repository/commits/${commitId}/merge_requests`,
      { headers, timeout: 10000 },
    );
    const mr = data?.[0];
    if (!mr) return null;
    return {
      id: mr.iid,
      title: mr.title,
      description: (mr.description || "").slice(0, 600),
      url: mr.web_url,
      labels: mr.labels || [],
      author: mr.author?.name || "",
      state: mr.state,
    };
  } catch {
    return null;
  }
}

// Fetches all pages of a GitLab paginated endpoint (uses x-next-page header)
async function fetchAllPages(url, params, headers, timeout = 20000) {
  let page = 1;
  let all = [];
  while (true) {
    const resp = await axios.get(url, { params: { ...params, per_page: 100, page }, headers, timeout });
    all = all.concat(resp.data);
    const next = resp.headers['x-next-page'];
    if (!next || next === '' || next === '0') break;
    page = parseInt(next, 10);
  }
  return all;
}


router.get("/commit-analysis/patterns", (_req, res) => {
  res.json({
    cls: CLS_PATTERNS.map(
      ({ id, description, detail, fix, fixCode, severity }) => ({
        id,
        description,
        detail,
        fix,
        fixCode,
        severity,
      }),
    ),
    inp: INP_PATTERNS.map(
      ({ id, description, detail, fix, fixCode, severity }) => ({
        id,
        description,
        detail,
        fix,
        fixCode,
        severity,
      }),
    ),
  });
});

router.post("/commit-analysis", async (req, res) => {
  const { date, metric } = req.body;

  if (!date || !DATE_RE.test(date)) {
    return res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
  }
  if (!metric || !["cls", "inp", "both"].includes(metric)) {
    return res.status(400).json({ error: "metric must be cls, inp, or both" });
  }

  const since = `${date}T00:00:00.000Z`;
  const until = `${date}T23:59:59.999Z`;

  let headers;
  try {
    headers = getGitLabHeaders();
  } catch (e) {
    return res.status(503).json({ error: e.message });
  }

  try {
    const { data: commits } = await axios.get(
      `${GITLAB_BASE}/projects/${PROJECT_PATH}/repository/commits`,
      {
        params: { since, until, per_page: 50, with_stats: false },
        headers,
        timeout: 20000,
      },
    );

    if (!commits.length) {
      return res.json({
        date,
        metric,
        commits: [],
        totalCommits: 0,
        message: "No commits found on this date",
      });
    }

    const results = await Promise.allSettled(
      commits.slice(0, 30).map(async (commit) => {
        const [diffResult, mrResult] = await Promise.allSettled([
          fetchAllPages(
            `${GITLAB_BASE}/projects/${PROJECT_PATH}/repository/commits/${commit.id}/diff`,
            {}, headers, 20000,
          ),
          fetchMRInfo(commit.id, headers),
        ]);

        const diffs = diffResult.status === "fulfilled" ? diffResult.value : [];
        const mrInfo = mrResult.status === "fulfilled" ? mrResult.value : null;

        const frontendDiffs = diffs.filter((d) =>
          /\.(jsx?|tsx?|vue|css|scss|less|html?|ejs)$/.test(d.new_path),
        );

        const fileResults = frontendDiffs
          .map((d) => {
            const findings = analyzeDiff(d.diff || "", metric);
            const addedCount = (d.diff || "")
              .split("\n")
              .filter((l) => l.startsWith("+") && !l.startsWith("+" + "+"))
              .length;
            return { file: d.new_path, addedLineCount: addedCount, findings };
          })
          .filter((f) => f.findings.length > 0);

        // All frontend files changed in this commit (for per-file AI buttons)
        const changedFiles = frontendDiffs.map((d) => ({
          file: d.new_path,
          oldPath: d.old_path,
          isNew: d.new_file,
          isDeleted: d.deleted_file,
          isRenamed: d.renamed_file,
          addedLineCount: (d.diff || "")
            .split("\n")
            .filter((l) => l.startsWith("+") && !l.startsWith("+" + "+"))
            .length,
          removedLineCount: (d.diff || "")
            .split("\n")
            .filter((l) => l.startsWith("-") && !l.startsWith("-" + "-"))
            .length,
          rawDiff: d.diff || "",
        }));

        const allFindings = fileResults.flatMap((f) => f.findings);
        const score = riskScore(allFindings);

        return {
          id: commit.id,
          shortId: commit.short_id,
          title: commit.title,
          message: commit.message,
          author: commit.author_name,
          authorEmail: commit.author_email,
          committedAt: commit.committed_date,
          webUrl: `https://gitlab.infoedge.com/ambitionbox/monorepo-web-native/-/commit/${commit.id}`,
          filesChanged: diffs.length,
          riskScore: score,
          riskLevel: riskLevel(score),
          mrInfo,
          fileResults,
          changedFiles,
        };
      }),
    );

    const analyzed = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      const c = commits[i];
      return {
        id: c.id,
        shortId: c.short_id,
        title: c.title,
        author: c.author_name,
        committedAt: c.committed_date,
        webUrl: `https://gitlab.infoedge.com/ambitionbox/monorepo-web-native/-/commit/${c.id}`,
        riskScore: 0,
        riskLevel: "unknown",
        mrInfo: null,
        fileResults: [],
        error: "Could not fetch diff for this commit",
      };
    });

    const ORDER = { high: 0, medium: 1, low: 2, none: 3, unknown: 4 };
    analyzed.sort((a, b) => {
      const od = (ORDER[a.riskLevel] ?? 5) - (ORDER[b.riskLevel] ?? 5);
      return od !== 0 ? od : b.riskScore - a.riskScore;
    });

    res.json({
      date,
      metric,
      totalCommits: commits.length,
      affectedCommits: analyzed.filter((c) => c.riskScore > 0).length,
      commits: analyzed,
    });
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.message || e.message;
    if (status === 401 || status === 403)
      return res
        .status(403)
        .json({ error: "GitLab auth failed. Check GITLAB_TOKEN." });
    if (status === 404)
      return res.status(404).json({ error: "GitLab project not found." });
    res.status(500).json({ error: msg });
  }
});

// ── AI deep-file analysis via Claude Code CLI ────────────────────────────────
// POST /api/commit-analysis/ai-analyze
// Spawns the local `claude --print` CLI (already authenticated via Claude Code)
// to read the full file + diff and give code-specific INP/CLS analysis.

const { spawn } = require("child_process");

function runClaudeCLI(prompt, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["--print"], {
      env: { ...process.env, PATH: process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";

    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });

    child.on("error", (e) => {
      if (e.code === "ENOENT")
        reject(new Error("claude CLI not found — is Claude Code installed?"));
      else reject(e);
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Claude CLI timed out after 2 minutes"));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (out.trim()) resolve(out.trim());
      else reject(new Error(err.trim() || `claude exited with code ${code}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Streams SSE events: { type: 'status'|'token'|'done'|'error', text }
// Analyses a single file from a commit — small focused prompt, fast response
router.post("/commit-analysis/ai-analyze", async (req, res) => {
  const { commitSha, filePath, metric } = req.body;

  if (!commitSha || !filePath) {
    return res
      .status(400)
      .json({ error: "commitSha and filePath are required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let gitHeaders;
  try {
    gitHeaders = getGitLabHeaders();
  } catch (e) {
    send({ type: "error", text: e.message });
    return res.end();
  }

  try {
    send({ type: "status", text: "Fetching diff..." });

    const diffs = await fetchAllPages(
      `${GITLAB_BASE}/projects/${PROJECT_PATH}/repository/commits/${commitSha}/diff`,
      {}, gitHeaders, 20000,
    );

    const fileDiff = diffs.find(
      (d) => d.new_path === filePath || d.old_path === filePath,
    );
    if (!fileDiff) {
      send({
        type: "error",
        text: `${filePath} not found in this commit's diff.`,
      });
      return res.end();
    }

    send({ type: "status", text: "Fetching file content..." });

    let fileContent = "";
    try {
      const {
        data,
      } = await axios.get(
        `${GITLAB_BASE}/projects/${PROJECT_PATH}/repository/files/${encodeURIComponent(
          filePath,
        )}/raw`,
        { params: { ref: commitSha }, headers: gitHeaders, timeout: 15000 },
      );
      fileContent = (typeof data === "string" ? data : "")
        .split("\n")
        .slice(0, 300)
        .join("\n");
    } catch {
      fileContent = "(could not fetch)";
    }

    const metricLabel =
      metric === "cls"
        ? "CLS (Cumulative Layout Shift)"
        : metric === "inp"
        ? "INP (Interaction to Next Paint)"
        : "INP and CLS";

    const prompt = `You are a Core Web Vitals expert reviewing a single file in AmbitionBox's production Next.js monorepo.

FILE: ${filePath}
COMMIT: ${commitSha}
INVESTIGATE: ${metricLabel}

=== DIFF (what changed) ===
${(fileDiff.diff || "").slice(0, 4000)}

=== FULL FILE (current state, up to 300 lines) ===
${fileContent}

Analyse this file for real ${metricLabel} issues introduced or worsened by this change.

For each issue found:
1. Name the exact component/hook/function (use real names from the code above)
2. Quote the specific problematic line(s)
3. Explain concretely WHY it hurts ${metricLabel}
4. Show the exact fix using real variable/function names from this file

If no real ${metricLabel} issues exist here, say so in one sentence.
Keep response under 350 words. Be specific, not generic.`;

    send({ type: "status", text: "Claude is analysing..." });

    const child = spawn("claude", ["--print"], {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) =>
      send({ type: "token", text: chunk.toString() }),
    );
    child.stderr.on("data", () => {});

    child.on("error", (e) => {
      send({ type: "error", text: e.message });
      res.end();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      send({ type: "error", text: "Timed out after 2 minutes." });
      res.end();
    }, 120000);

    child.on("close", () => {
      clearTimeout(timer);
      send({ type: "done" });
      res.end();
    });

    child.stdin.write(prompt);
    child.stdin.end();
  } catch (e) {
    send({ type: "error", text: e.response?.data?.message || e.message });
    res.end();
  }
});

// ── Codex (OpenAI CLI) per-file analysis — mirrors claude --print approach ──
// POST /api/commit-analysis/ai-analyze-codex
router.post("/commit-analysis/ai-analyze-codex", async (req, res) => {
  const { commitSha, filePath, metric } = req.body;

  if (!commitSha || !filePath) {
    return res.status(400).json({ error: "commitSha and filePath are required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let gitHeaders;
  try {
    gitHeaders = getGitLabHeaders();
  } catch (e) {
    send({ type: "error", text: e.message });
    return res.end();
  }

  try {
    send({ type: "status", text: "Fetching diff..." });

    const diffs = await fetchAllPages(
      `${GITLAB_BASE}/projects/${PROJECT_PATH}/repository/commits/${commitSha}/diff`,
      {}, gitHeaders, 20000,
    );

    const fileDiff = diffs.find(
      (d) => d.new_path === filePath || d.old_path === filePath,
    );
    if (!fileDiff) {
      send({ type: "error", text: `${filePath} not found in this commit's diff.` });
      return res.end();
    }

    send({ type: "status", text: "Fetching file content..." });

    let fileContext = "";
    try {
      const { data } = await axios.get(
        `${GITLAB_BASE}/projects/${PROJECT_PATH}/repository/files/${encodeURIComponent(filePath)}/raw`,
        { params: { ref: commitSha }, headers: gitHeaders, timeout: 15000 },
      );
      fileContext = buildCodexFileContext(data, fileDiff.diff);
    } catch {
      fileContext = "(could not fetch)";
    }

    const metricLabel =
      metric === "cls" ? "CLS (Cumulative Layout Shift)"
      : metric === "inp" ? "INP (Interaction to Next Paint)"
      : "INP and CLS";

    const prompt = `You are a Core Web Vitals expert reviewing a single file in AmbitionBox's production Next.js monorepo.

FILE: ${filePath}
COMMIT: ${commitSha}
INVESTIGATE: ${metricLabel}

=== DIFF (what changed) ===
${(fileDiff.diff || "").slice(0, CODEX_DIFF_CHAR_LIMIT)}

=== RELEVANT FILE CONTEXT (current state, 80 lines around each changed area) ===
${fileContext}

Analyse this file for real ${metricLabel} issues introduced or worsened by this change.

For each issue found:
1. Name the exact component/hook/function (use real names from the code above)
2. Quote the specific problematic line(s)
3. Explain concretely WHY it hurts ${metricLabel}
4. Show the exact fix using real variable/function names from this file

If no real ${metricLabel} issues exist here, say so in one sentence.
Keep response under 350 words. Be specific, not generic.`;

    send({ type: "status", text: "Codex is analysing..." });

    // codex exec reads prompt from stdin when '-' is passed
    const child = spawn("codex", ["exec", "-"], {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) =>
      send({ type: "token", text: chunk.toString() }),
    );
    child.stderr.on("data", () => {});

    // Absorb EPIPE — if codex closes stdin early, don't crash the server
    child.stdin.on("error", () => {});

    child.on("error", (e) => {
      const msg = e.code === "ENOENT"
        ? "codex CLI not found — run: npm install -g @openai/codex"
        : e.message;
      send({ type: "error", text: msg });
      res.end();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      send({ type: "error", text: "Timed out after 2 minutes." });
      res.end();
    }, 120000);

    child.on("close", () => {
      clearTimeout(timer);
      send({ type: "done" });
      res.end();
    });

    child.stdin.write(prompt);
    child.stdin.end();
  } catch (e) {
    send({ type: "error", text: e.response?.data?.message || e.message });
    res.end();
  }
});

module.exports = router;

// ── Create Fix MR ─────────────────────────────────────────────────────────────
// Fetches current master file, asks Claude to apply minimum CWV fixes,
// creates a branch + commit + MR on GitLab.
// Streams SSE: { type: 'status'|'done'|'error', text?, mrUrl?, mrIid?, mrTitle?, branch? }
router.post('/commit-analysis/create-fix-mr', async (req, res) => {
  const { filePath, metric, analysisText } = req.body;
  if (!filePath || !analysisText) {
    return res.status(400).json({ error: 'filePath and analysisText are required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let gitHeaders;
  try { gitHeaders = getGitLabHeaders(); } catch (e) {
    send({ type: 'error', text: e.message }); return res.end();
  }

  try {
    // 1. Fetch current file from master
    send({ type: 'status', text: 'Fetching current master file...' });
    let currentContent = '';
    try {
      const { data } = await axios.get(
        `${GITLAB_BASE}/projects/${PROJECT_PATH}/repository/files/${encodeURIComponent(filePath)}/raw`,
        { params: { ref: 'master' }, headers: gitHeaders, timeout: 15000 }
      );
      currentContent = typeof data === 'string' ? data : JSON.stringify(data);
    } catch (e) {
      send({ type: 'error', text: `Could not fetch master file: ${e.message}` }); return res.end();
    }

    const metricLabel = metric === 'cls' ? 'CLS (Cumulative Layout Shift)'
                      : metric === 'inp' ? 'INP (Interaction to Next Paint)'
                      : 'INP and CLS';

    // 2. Ask Claude to apply minimum fixes to the current file
    send({ type: 'status', text: 'Asking Claude to generate fix...' });

    const fixPrompt =
`You are fixing ${metricLabel} performance issues in a production Next.js file for AmbitionBox.

FILE: ${filePath}

ISSUES TO FIX (from analysis):
${analysisText}

CURRENT FILE CONTENT (from master branch):
${currentContent.split('\n').slice(0, 400).join('\n')}

Task: Apply ONLY the minimum changes needed to fix the ${metricLabel} issues listed above.
Rules:
- Do NOT change any logic, business functionality, or code unrelated to the CWV fix
- Keep all imports, exports, component names, and structure identical unless they must change for the fix
- If an issue is no longer present in the current file, skip it
- Return the COMPLETE fixed file content — raw code only, no markdown fences, no explanation`;

    const fixedRaw = await runClaudeCLI(fixPrompt, 180000);

    // Strip markdown code fences if Claude wrapped output
    const fixedContent = fixedRaw
      .replace(/^```[\w]*\r?\n/, '')
      .replace(/\r?\n```$/, '')
      .trim();

    if (!fixedContent || fixedContent.length < 20) {
      send({ type: 'error', text: 'Claude returned empty fix — try again.' }); return res.end();
    }

    // 3. Create branch
    const fileBase = filePath.split('/').pop().replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
    const dateSuffix = new Date().toISOString().slice(0, 10);
    const branchName = `cwv-fix-${metric}-${fileBase}-${dateSuffix}`;

    send({ type: 'status', text: `Creating branch ${branchName}...` });
    try {
      await axios.post(
        `${GITLAB_BASE}/projects/${PROJECT_PATH}/repository/branches`,
        { branch: branchName, ref: 'master' },
        { headers: gitHeaders, timeout: 10000 }
      );
    } catch (e) {
      // Branch might already exist — try with a timestamp suffix
      const branchNameTs = `${branchName}-${Date.now()}`;
      send({ type: 'status', text: `Branch exists, using ${branchNameTs}...` });
      await axios.post(
        `${GITLAB_BASE}/projects/${PROJECT_PATH}/repository/branches`,
        { branch: branchNameTs, ref: 'master' },
        { headers: gitHeaders, timeout: 10000 }
      );
    }

    // Get the actual branch name that was created
    const usedBranch = branchName;

    // 4. Commit the fixed file
    send({ type: 'status', text: 'Committing fix...' });
    await axios.put(
      `${GITLAB_BASE}/projects/${PROJECT_PATH}/repository/files/${encodeURIComponent(filePath)}`,
      {
        branch: usedBranch,
        content: fixedContent,
        commit_message: `fix(cwv): optimise ${filePath.split('/').pop()} for ${metric.toUpperCase()}\n\nAI-generated CWV fix via CWV Analyser. Review carefully before merging.`,
        encoding: 'text',
      },
      { headers: gitHeaders, timeout: 20000 }
    );

    // 5. Create MR
    send({ type: 'status', text: 'Creating merge request...' });
    const { data: mr } = await axios.post(
      `${GITLAB_BASE}/projects/${PROJECT_PATH}/merge_requests`,
      {
        source_branch: usedBranch,
        target_branch: 'master',
        title: `fix(cwv): ${metric.toUpperCase()} optimisation in ${filePath.split('/').pop()}`,
        description: `## CWV Optimisation — ${metric.toUpperCase()}\n\n**File:** \`${filePath}\`\n\n### What was changed\n\nAI-generated minimum fix for ${metricLabel} issues identified in the commit analyser.\n\n### AI Analysis that drove this fix\n\n${analysisText}\n\n---\n> ⚠ Auto-generated by CWV Commit Analyser. Please review the diff carefully before merging.`,
        labels: ['cwv', 'performance'],
        remove_source_branch: true,
        squash: false,
      },
      { headers: gitHeaders, timeout: 15000 }
    );

    send({ type: 'done', mrUrl: mr.web_url, mrIid: mr.iid, mrTitle: mr.title, branch: usedBranch });
    res.end();

  } catch (e) {
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    send({ type: 'error', text: msg });
    res.end();
  }
});
