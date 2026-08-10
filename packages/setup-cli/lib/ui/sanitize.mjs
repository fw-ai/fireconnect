/**
 * Strip terminal escapes and control characters from untrusted text before
 * writing it to a TTY (session titles, prompts, model ids, etc.).
 */

/**
 * @param {unknown} text
 * @returns {string}
 */
export function sanitize(text) {
  return String(text ?? "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
