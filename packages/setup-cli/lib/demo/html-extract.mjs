/**
 * Extract a single self-contained HTML document from a model's raw output.
 *
 * Models are told to return only an HTML file with no fences, but in practice
 * they often wrap output in ```html ... ``` or add leading prose. This recovers
 * the document honestly: it never fabricates HTML that wasn't in the output.
 */

/**
 * @param {string} raw
 * @returns {{ html: string, ok: boolean, reason?: string }}
 */
export function extractHtml(raw) {
  if (!raw || !raw.trim()) {
    return { html: "", ok: false, reason: "empty output" };
  }

  // Strip markdown code fences. Handles ```html ... ``` and bare ``` ... ```.
  const fenced = raw.match(/```(?:html|HTML)?\s*\n?([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;

  const trimmed = candidate.trim();
  if (!trimmed) {
    return { html: "", ok: false, reason: "empty after fence strip" };
  }

  // Prefer the substring from the first <!doctype>/<html> to the last </html>,
  // which trims surrounding prose without dropping document content.
  const openIdx = lowerIndexOf(trimmed, ["<!doctype html", "<html"]);
  const closeIdx = trimmed.toLowerCase().lastIndexOf("</html>");

  if (openIdx >= 0 && closeIdx > openIdx) {
    return { html: trimmed.slice(openIdx, closeIdx + "</html>".length).trim(), ok: true };
  }
  if (openIdx >= 0) {
    // Has an opening tag but no closing </html> — take to end, mark not runnable.
    return {
      html: trimmed.slice(openIdx).trim(),
      ok: true,
      reason: "missing </html>",
    };
  }

  // No html/doctype marker at all. If it still looks like an HTML fragment
  // (starts with a tag), keep it but flag; otherwise return raw as-is so the
  // browser panel can show "didn't run" honestly.
  if (trimmed.startsWith("<")) {
    return { html: trimmed, ok: true, reason: "no doctype/html root" };
  }
  return { html: trimmed, ok: false, reason: "no html detected" };
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
  return lower.includes("<html") || lower.includes("<body") || lower.includes("<script");
}

function lowerIndexOf(haystack, needles) {
  const lower = haystack.toLowerCase();
  let best = -1;
  for (const needle of needles) {
    const idx = lower.indexOf(needle);
    if (idx >= 0 && (best === -1 || idx < best)) {
      best = idx;
    }
  }
  return best;
}
