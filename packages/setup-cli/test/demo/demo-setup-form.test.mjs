import test from "node:test";
import assert from "node:assert/strict";

import {
  createFormState,
  applyKey,
  formResult,
  curatedChallengers,
} from "../../lib/demo/setup-form.mjs";

const DEFAULTS = {
  promptSource: "preset",
  promptPresetId: "tetris",
  challenger: "glm-5p2-fast",
  out: "./fireconnect-demo",
};

function state(overrides = {}) {
  return createFormState({ defaults: { ...DEFAULTS, ...overrides.defaults } });
}

function focusOn(s, key) {
  let cur = s;
  const fieldIndex = cur.fields.findIndex((f) => f.key === key);
  assert.ok(fieldIndex >= 0, `field ${key} should exist`);
  while (cur.focus !== fieldIndex) {
    cur = applyKey(cur, cur.focus < fieldIndex ? "down" : "up");
  }
  return cur;
}

function keys(s) {
  return s.fields.map((f) => f.key);
}

test("createFormState: prompt is field[0]; layout includes custom task field", () => {
  const s = state();
  assert.deepEqual(keys(s), ["prompt", "customPrompt", "incumbentModel", "challenger", "out"]);
  assert.equal(s.fields[0].key, "prompt");
  assert.equal(s.done, false);
  assert.equal(s.quit, false);
});

test("applyKey: down/up moves focus and clamps", () => {
  let s = state();
  s = applyKey(s, "down");
  assert.equal(s.focus, 1);
  s = applyKey(s, "down");
  s = applyKey(s, "down");
  s = applyKey(s, "down"); // last field (out) at index 4
  assert.equal(s.focus, 4);
  s = applyKey(s, "down"); // clamp
  assert.equal(s.focus, 4);
  s = applyKey(s, "up");
  assert.equal(s.focus, 3);
});

test("applyKey: ←/→ cycle a choice field and wrap", () => {
  let s = focusOn(state(), "prompt");
  const opts = s.fields[s.focus].options;
  s = applyKey(s, "right");
  assert.equal(s.fields[s.focus].index, 1);
  s = applyKey(s, "left");
  s = applyKey(s, "left"); // wrap back past 0
  assert.equal(s.fields[s.focus].index, opts.length - 1);
});

test("applyKey: 1-9 jumps to the nth option on a choice field", () => {
  let s = focusOn(state(), "challenger");
  s = applyKey(s, "3");
  assert.equal(s.fields[s.focus].index, 2);
  // out-of-range digits are ignored
  const len = s.fields[s.focus].options.length;
  s = applyKey(s, String(len + 1));
  assert.equal(s.fields[s.focus].index, 2);
});

test("applyKey: output dir accepts allowed chars, rejects others", () => {
  let s = focusOn(state(), "out");
  for (let i = 0; i < 20; i += 1) s = applyKey(s, "backspace");
  assert.equal(s.fields[s.focus].text, "");
  for (const ch of "/tmp") s = applyKey(s, ch);
  assert.equal(s.fields[s.focus].text, "/tmp");
  s = applyKey(s, " "); // space not allowed
  assert.equal(s.fields[s.focus].text, "/tmp");
});

test("applyKey: enter confirms, q/escape/ctrlc quit", () => {
  let s = state();
  s = applyKey(s, "enter");
  assert.equal(s.done, true);

  s = applyKey(state(), "escape");
  assert.equal(s.quit, true);

  s = applyKey(state(), "ctrlc");
  assert.equal(s.quit, true);

  // 'q' quits on a choice field (focus starts on prompt, a choice)
  s = applyKey(state(), "q");
  assert.equal(s.quit, true);
});

test("formResult: returns prompt + challenger + out + incumbent model", () => {
  let s = applyKey(state(), "enter");
  const r = formResult(s, { defaults: DEFAULTS });
  assert.equal(r.prompt, "tetris");
  assert.equal(r.challenger, "glm-5p2-fast");
  assert.equal(r.out, "./fireconnect-demo");
  assert.equal(r.incumbentModel, "opus"); // default
  assert.ok(!("seed" in r));
  assert.ok(!("leftProvider" in r));
  assert.ok(!("mode" in r));
});

test("formResult: returns the selected incumbent (Anthropic) model", () => {
  let s = focusOn(state(), "incumbentModel"); // default opus
  s = applyKey(s, "right"); // → sonnet
  s = applyKey(s, "enter");
  const r = formResult(s, { defaults: DEFAULTS });
  assert.equal(r.incumbentModel, "sonnet");
});

test("createFormState: incumbent model defaults to opus", () => {
  const s = state();
  const im = s.fields.find((f) => f.key === "incumbentModel");
  assert.equal(im.type, "choice");
  assert.equal(im.options[im.index], "opus");
});

test("formResult: custom (non-preset) prompt is preserved in the custom field", () => {
  const customDefaults = {
    ...DEFAULTS,
    promptSource: "literal",
    promptText: "build me a calculator",
    promptTitle: "Custom prompt",
  };
  let s = createFormState({ defaults: customDefaults });
  const promptField = s.fields.find((f) => f.key === "prompt");
  assert.equal(promptField.type, "choice");
  assert.equal(promptField.options[promptField.index], "custom");
  const customField = s.fields.find((f) => f.key === "customPrompt");
  assert.equal(customField.text, "build me a calculator");
  s = applyKey(s, "enter");
  const r = formResult(s, { defaults: customDefaults });
  assert.equal(r.prompt, "build me a calculator");
});

test("formResult: selecting custom uses the editable custom task field", () => {
  let s = focusOn(state(), "prompt");
  const promptField = s.fields[s.focus];
  const customIndex = promptField.options.indexOf("custom");
  assert.ok(customIndex >= 0);
  s = applyKey(s, String(customIndex + 1));
  s = focusOn(s, "customPrompt");
  for (const ch of "build a timer") s = applyKey(s, ch);
  s = applyKey(s, "enter");
  const r = formResult(s, { defaults: DEFAULTS });
  assert.equal(r.prompt, "build a timer");
});

test("applyKey: empty custom task cannot submit and focuses the custom field", () => {
  let s = focusOn(state(), "prompt");
  const customIndex = s.fields[s.focus].options.indexOf("custom");
  s = applyKey(s, String(customIndex + 1));
  s = applyKey(s, "enter");
  assert.equal(s.done, false);
  assert.equal(s.fields[s.focus].key, "customPrompt");
});

test("formResult: empty custom task returns the custom sentinel, never a previous preset prompt", () => {
  let s = focusOn(state(), "prompt");
  const customIndex = s.fields[s.focus].options.indexOf("custom");
  s = applyKey(s, String(customIndex + 1));
  const r = formResult(s, { defaults: { ...DEFAULTS, promptText: "tetris prompt should not leak" } });
  assert.equal(r.prompt, "custom");
  assert.equal(r.promptSource, "custom-empty");
});

test("formResult: a literal 'custom' task is a literal source, not the sentinel", () => {
  let s = focusOn(state(), "prompt");
  const customIndex = s.fields[s.focus].options.indexOf("custom");
  s = applyKey(s, String(customIndex + 1));
  s = focusOn(s, "customPrompt");
  for (const ch of "custom") s = applyKey(s, ch);
  s = applyKey(s, "enter");
  const r = formResult(s, { defaults: DEFAULTS });
  assert.equal(r.prompt, "custom");
  assert.equal(r.promptSource, "literal");
});

test("formResult: non-curated challenger is read-only and preserved", () => {
  const d = { ...DEFAULTS, challenger: "some-other-model" };
  let s = createFormState({ defaults: d });
  const ch = s.fields.find((f) => f.key === "challenger");
  assert.equal(ch.type, "readonly");
  s = applyKey(s, "enter");
  const r = formResult(s, { defaults: d });
  assert.equal(r.challenger, "some-other-model");
});

test("curatedChallengers: every entry has a label", () => {
  const list = curatedChallengers();
  assert.ok(list.length >= 4);
  for (const c of list) {
    assert.ok(c.label, `${c.id} needs a label`);
  }
  assert.equal(list[0].id, "glm-5p2-fast");
});
