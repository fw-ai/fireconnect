import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promptCheckbox, promptSearch, promptSelect, splitKeys, createKeyParser } from "../../lib/ui/prompt.mjs";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode() { return this; }
  resume() { return this; }
  pause() { return this; }
  setEncoding() { return this; }
}

class FakeOutput {
  isTTY = true;
  columns = 100;
  chunks = [];
  write(chunk) {
    this.chunks.push(chunk);
    return true;
  }
  text() {
    return this.chunks.join("");
  }
}

/** Run a prompt and feed it key sequences once it has rendered. */
function drive(promptPromiseFactory, keys) {
  const input = new FakeInput();
  const output = new FakeOutput();
  const result = promptPromiseFactory({ input, output });
  // Feed keys on the next tick so the prompt's data listener is attached.
  setImmediate(() => {
    for (const key of keys) {
      input.emit("data", key);
    }
  });
  return result.then((value) => ({ value, output }));
}

describe("splitKeys", () => {
  it("splits CSI sequences from plain chars", () => {
    assert.deepEqual([...splitKeys(`ab${UP}c`)], ["a", "b", UP, "c"]);
    assert.deepEqual([...splitKeys(ESC)], [ESC]);
  });
});

describe("createKeyParser", () => {
  it("reassembles arrow keys split across stdin chunks", () => {
    const parser = createKeyParser();
    assert.deepEqual(parser.push("\x1b"), []);
    assert.deepEqual(parser.push("[A"), [UP]);
  });
});

describe("promptSelect", () => {
  const choices = [
    { name: "first", value: "one" },
    { name: "second", value: "two" },
    { name: "third", value: "three" },
  ];

  it("returns the highlighted value on Enter", async () => {
    const { value } = await drive(
      (streams) => promptSelect({ message: "Pick", choices, ...streams }),
      [DOWN, ENTER],
    );
    assert.equal(value, "two");
  });

  it("wraps around the top", async () => {
    const { value } = await drive(
      (streams) => promptSelect({ message: "Pick", choices, ...streams }),
      [UP, ENTER],
    );
    assert.equal(value, "three");
  });

  it("returns null on Esc", async () => {
    const { value } = await drive(
      (streams) => promptSelect({ message: "Pick", choices, ...streams }),
      [ESC],
    );
    assert.equal(value, null);
  });

  it("selects by number key", async () => {
    const { value } = await drive(
      (streams) => promptSelect({ message: "Pick", choices, ...streams }),
      ["2"],
    );
    assert.equal(value, "two");
  });

  it("handles arrow keys split across chunks", async () => {
    const { value } = await drive(
      (streams) => promptSelect({ message: "Pick", choices, ...streams }),
      ["\x1b", "[B", ENTER],
    );
    assert.equal(value, "two");
  });

  it("prints a summary line with the answer", async () => {
    const { output } = await drive(
      (streams) => promptSelect({ message: "Pick", choices, ...streams }),
      [ENTER],
    );
    assert.ok(output.text().includes("Pick"));
    assert.ok(output.text().includes("first"));
  });
});

describe("promptCheckbox", () => {
  const choices = [
    { name: "alpha", value: "a" },
    { name: "beta", value: "b", checked: true },
    { name: "gamma", value: "c" },
  ];

  it("respects defaults and toggles with space", async () => {
    const { value } = await drive(
      (streams) => promptCheckbox({ message: "Which", choices, ...streams }),
      [" ", ENTER], // toggle alpha on (beta already checked)
    );
    assert.deepEqual(value, ["a", "b"]);
  });

  it("re-asks when validate rejects, then accepts", async () => {
    const { value } = await drive(
      (streams) => promptCheckbox({
        message: "Which",
        choices: [{ name: "alpha", value: "a" }],
        validate: (picked) => (picked.length > 0 ? true : "pick one"),
        ...streams,
      }),
      [ENTER, " ", ENTER], // first Enter rejected (empty), then toggle + Enter
    );
    assert.deepEqual(value, ["a"]);
  });

  it("returns null on Esc", async () => {
    const { value } = await drive(
      (streams) => promptCheckbox({ message: "Which", choices, ...streams }),
      [ESC],
    );
    assert.equal(value, null);
  });
});

describe("promptSearch", () => {
  const items = [
    { shortId: "glm-5p1", displayName: "GLM 5.1" },
    { shortId: "deepseek-v4", displayName: "DeepSeek v4" },
    { shortId: "kimi-k3", displayName: "Kimi K3" },
  ];
  const filter = (all, term) => all.filter((entry) => entry.shortId.includes(term));
  const toChoice = (entry) => ({ name: entry.shortId, short: entry.shortId });

  it("narrows with typed characters and picks on Enter", async () => {
    const { value } = await drive(
      (streams) => promptSearch({ message: "Model", items, filter, toChoice, ...streams }),
      ["k", "i", "m", ENTER],
    );
    assert.equal(value.shortId, "kimi-k3");
  });

  it("backspace widens the filter", async () => {
    const { value } = await drive(
      (streams) => promptSearch({ message: "Model", items, filter, toChoice, ...streams }),
      ["z", "\x7f", DOWN, ENTER], // "z" matches nothing, backspace restores, pick #2
    );
    assert.equal(value.shortId, "deepseek-v4");
  });

  it("Enter with no matches does nothing; Esc cancels", async () => {
    const { value } = await drive(
      (streams) => promptSearch({ message: "Model", items, filter, toChoice, ...streams }),
      ["z", ENTER, ESC],
    );
    assert.equal(value, null);
  });
});
