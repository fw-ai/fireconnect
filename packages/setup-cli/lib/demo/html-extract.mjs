/**
 * Extract a single self-contained HTML document from a model's raw output.
 *
 * Models are told to return only an HTML file, but in practice they add
 * fences or prose, and some "roleplay" a tool call — a JSON object whose
 * content field carries the escaped document — leaving two copies in the
 * output, only one of which is real HTML. This recovers the document
 * honestly: it never fabricates HTML that wasn't in the output.
 */

const DOCTYPE = "<!doctype html";
const HTML_OPEN = "<html";
const CLOSE = "</html>";
// Fenced block whose closing fence matches its opening length (3+ backticks),
// so ````-style fences used to dodge a "no fences" instruction still strip.
// The info string (```html, ````json, …) is ignored.
const FENCE_RE = /(`{3,})[^\n]*\n?([\s\S]*?)\n?\1/;

/**
 * @param {string} raw
 * @returns {{ html: string, ok: boolean, reason?: string }}
 */
export function extractHtml(raw) {
  if (!raw || !raw.trim()) {
    return { html: "", ok: false, reason: "empty output" };
  }
  // Prefer a complete document from the first fenced block, but fall back to
  // the full output so a truncated or garbage fence can't hide a real
  // document that follows it.
  const fromFence = raw.match(FENCE_RE)?.[2];
  const fenced = fromFence !== undefined ? extractFrom(fromFence) : null;
  if (fenced?.ok && !fenced.reason) {
    return fenced;
  }
  const whole = extractFrom(raw);
  if (whole.ok && !whole.reason) {
    return whole;
  }
  // Neither yielded a complete document: keep the better partial (the fence,
  // as the model's intended payload, wins ties).
  return fenced?.ok ? fenced : whole;
}

function extractFrom(candidate) {
  // A roleplayed tool call is a JSON object with the document in a string
  // field; JSON.parse unescapes it for free.
  const fromJson = jsonHtml(candidate);
  const trimmed = (fromJson ?? candidate).trim();
  if (!trimmed) {
    return { html: "", ok: false, reason: "empty after fence strip" };
  }

  const copies = findCopies(trimmed);
  if (copies.length === 0) {
    // No document marker at all. Keep tag-leading fragments (flagged) so the
    // browser panel can show "didn't run" honestly; anything else isn't HTML.
    return trimmed.startsWith("<")
      ? { html: trimmed, ok: true, reason: "no doctype/html root" }
      : { html: trimmed, ok: false, reason: "no html detected" };
  }

  // Rank copies: complete beats truncated, doctype-leading beats bare
  // <html> (prose mentions "<html>" but payloads start with a doctype), then
  // fewest escape artifacts / internal fences (a fragment that borrows a
  // later copy's close tag swallows prose and fences into its span). The
  // first copy wins ties.
  let best = null;
  for (const c of copies) {
    const html = trimmed.slice(c.open, c.end).trim();
    const score =
      (c.complete ? 0 : 1000) +
      (c.doctype ? 0 : 10) +
      (html.includes("```") ? 10 : 0) +
      artifactScore(html);
    if (!best || score < best.score) {
      best = { html, score, complete: c.complete };
    }
  }
  return best.complete
    ? { html: best.html, ok: true }
    : { html: best.html, ok: true, reason: "missing </html>" };
}

/**
 * A quick, honest runnability heuristic: does the extracted HTML look like it
 * could run in an iframe (has an <html> or <body> or at least one <script>)?
 * Used only to decide panel framing; the browser itself is the real test.
 *
 * @param {string} html
 * @returns {boolean}
 */
export function looksRunnable(html) {
  if (!html) {
    return false;
  }
  const lower = html.toLowerCase();
  return lower.includes(HTML_OPEN) || lower.includes("<body") || lower.includes("<script");
}

/** If candidate holds a JSON object whose string field IS an HTML document, return it. */
function jsonHtml(candidate) {
  // The object may sit in surrounding prose ("Write: {…}"); find it via the
  // outermost {...} span rather than parsing the whole string.
  const open = candidate.indexOf("{");
  const close = candidate.lastIndexOf("}");
  if (open === -1 || close <= open) {
    return null;
  }
  try {
    const obj = JSON.parse(candidate.slice(open, close + 1));
    for (const key of ["content", "html", "text", "code", "body"]) {
      const v = obj?.[key];
      // Must BE a document (start with a root tag), not merely mention one.
      if (typeof v === "string" && /^<!doctype html|^<html[\s>]/i.test(v.trim())) {
        return v;
      }
    }
  } catch {
    // Not valid JSON — copy ranking below may still recover the document.
  }
  return null;
}

/** Every document copy: each open marker through its next close tag (if any). */
function findCopies(haystack) {
  const lower = haystack.toLowerCase();
  /** @type {{ open: number, marker: string }[]} */
  const opens = [];
  for (const marker of [DOCTYPE, HTML_OPEN]) {
    for (let i = lower.indexOf(marker); i !== -1; i = lower.indexOf(marker, i + 1)) {
      opens.push({ open: i, marker });
    }
  }
  return opens
    .sort((a, b) => a.open - b.open)
    .map(({ open, marker }) => {
      const close = findClose(lower, open);
      return {
        open,
        end: close === -1 ? haystack.length : close,
        complete: close !== -1,
        doctype: marker === DOCTYPE,
      };
    });
}

/** End index of the next close tag, or -1; handles JSON-escaped `<\/html>`. */
function findClose(lower, from) {
  const plain = lower.indexOf(CLOSE, from);
  const escaped = lower.indexOf("<\\/html>", from);
  if (plain === -1) return escaped === -1 ? -1 : escaped + 8;
  if (escaped === -1) return plain + 7;
  return Math.min(plain + 7, escaped + 8);
}

/** How escape-laden a copy is: literal \" \n \t \/ \\ sequences, plus leaked control tags. */
function artifactScore(html) {
  const escapes = html.match(/\\["'nt/\\]/g);
  return (escapes ? escapes.length : 0) + (/antml:/.test(html) ? 10 : 0);
}
