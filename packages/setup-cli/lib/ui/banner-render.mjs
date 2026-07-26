/** @typedef {ReturnType<import("./theme.mjs").createTheme>} Theme */

const MARKUP_TAGS = ["spark", "burst", "core", "trail", "ember", "brand", "fuse"];
const TAG_PATTERN = new RegExp(`\\{(/?)(${MARKUP_TAGS.join("|")})\\}`, "g");

/**
 * Strip {tag} markup for plain-text / NO_COLOR output.
 * @param {string} line
 */
export function stripBannerMarkup(line) {
  TAG_PATTERN.lastIndex = 0;
  return line.replace(TAG_PATTERN, "");
}

/**
 * Horizontally center each art line on a shared axis (the widest line), so the
 * banner is centered at render time rather than by hand-padding the source
 * file. The art in banners/*.txt is stored flush-left; this is the single
 * source of truth for centering, which makes miscentering structurally
 * impossible: edit or add a line and it re-centers automatically.
 *
 * Width is measured on the *visible* text (markup stripped, whitespace
 * trimmed), and padding is floored consistently. Flooring — not rounding —
 * matters: it guarantees the top and bottom halves share one axis, and that
 * derived rows (e.g. the flame tips "^" vs the cone peaks "/^\") stay column-
 * aligned instead of drifting a column apart on odd/even width differences.
 * Leading/trailing plain-space indentation in the source is stripped first, so
 * re-centering is idempotent even if the art carries stray padding.
 *
 * @param {string} art
 */
export function centerBannerArt(art) {
  const rawLines = art.split("\n");
  const visibleWidths = rawLines.map((line) => stripBannerMarkup(line).trim().length);
  const axisWidth = Math.max(0, ...visibleWidths);

  return rawLines
    .map((line, i) => {
      const width = visibleWidths[i];
      if (width === 0) {
        return "";
      }
      const pad = Math.max(0, Math.floor((axisWidth - width) / 2));
      const flushLeft = line.replace(/^ +/, "").replace(/ +$/, "");
      return " ".repeat(pad) + flushLeft;
    })
    .join("\n");
}

/**
 * Parse `{tag}...{/tag}` markup into a tree so nested tags (e.g. {brand}
 * inside {burst}) can be rendered inside-out as real nested function calls.
 * Rendering them as independent flat regex passes -- the previous approach
 * -- applies each style to text that still contains raw, unresolved markup
 * for tags nested inside it, so the outer style's ANSI codes never actually
 * wrap the inner style's output, and colors were dropping after the first
 * nested span closed.
 * @param {string} line
 * @returns {Array<string | { tag: string, children: ReturnType<typeof parseBannerMarkup> }>}
 */
function parseBannerMarkup(line) {
  const root = [];
  const stack = [root];
  TAG_PATTERN.lastIndex = 0;
  let cursor = 0;
  let match;
  while ((match = TAG_PATTERN.exec(line)) !== null) {
    const [full, closing, tag] = match;
    const text = line.slice(cursor, match.index);
    if (text) {
      stack[stack.length - 1].push(text);
    }
    cursor = match.index + full.length;

    if (!closing) {
      const node = { tag, children: [] };
      stack[stack.length - 1].push(node);
      stack.push(node.children);
    } else if (stack.length > 1) {
      stack.pop();
    }
  }
  const rest = line.slice(cursor);
  if (rest) {
    stack[stack.length - 1].push(rest);
  }
  return root;
}

/**
 * @param {ReturnType<typeof parseBannerMarkup>} nodes
 * @param {Record<string, (text: string) => string>} styles
 * @returns {string}
 */
function renderBannerNodes(nodes, styles) {
  return nodes
    .map((node) => {
      if (typeof node === "string") {
        return node;
      }
      const inner = renderBannerNodes(node.children, styles);
      const style = styles[node.tag];
      return style ? style(inner) : inner;
    })
    .join("");
}

/**
 * @param {string} line
 * @param {Theme} theme
 */
export function renderBannerLine(line, theme) {
  if (!theme.color) {
    return stripBannerMarkup(line);
  }

  /** @type {Record<string, (text: string) => string>} */
  const styles = {
    spark: theme.spark,
    burst: theme.burst,
    core: theme.core,
    trail: theme.trail,
    ember: theme.ember,
    brand: theme.brand,
    fuse: theme.muted,
  };

  return renderBannerNodes(parseBannerMarkup(line), styles);
}
