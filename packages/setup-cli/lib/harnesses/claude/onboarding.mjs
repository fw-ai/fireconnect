import process from "node:process";

import { ANSI, accent, paint } from "../../ui.mjs";
import { formatClaudeSlotModelLabel } from "../../fireworks/model-id.mjs";

export function printClaudePickerSummary({
  extraPickerModel = null,
  firepass = false,
} = {}, output = process.stdout) {
  output.write(`${paint(ANSI.bold, "Model picker", output)}\n`);
  if (firepass) {
    output.write(`  ${paint(ANSI.muted, "Fire Pass", output)} ${accent("→ pinned routers (see status)", output)}\n`);
  } else {
    output.write(`  ${paint(ANSI.muted, "Anthropic model slots", output)} ${accent("→ unchanged", output)}\n`);
    output.write(`  ${paint(ANSI.muted, "Fireworks catalog", output)} ${accent("→ appended in /model", output)}\n`);
    if (extraPickerModel) {
      output.write([
        "  ",
        paint(ANSI.muted, "Added via --model", output),
        ` ${accent("→", output)} `,
        accent(formatClaudeSlotModelLabel(extraPickerModel), output),
        "\n",
      ].join(""));
    }
  }
  output.write("\n");
}
