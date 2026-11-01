import { describe, expect, it } from "vitest";
import { mergePromptSegments, segmentUserText } from "../src/index.js";

const labels = (text: string) => segmentUserText(text).map((s) => [s.label, s.source, s.text]);

describe("segmentUserText", () => {
  it("treats plain text as typed", () => {
    expect(labels("fix the bug")).toEqual([["prompt", "typed", "fix the bug"]]);
  });

  it("separates injected tags from typed text", () => {
    const text =
      "<ide_opened_file>The user opened a.py in the IDE.</ide_opened_file>\nmake it faster<system-reminder>be nice</system-reminder>";
    expect(labels(text)).toEqual([
      ["system", "ide_opened_file", "The user opened a.py in the IDE."],
      ["prompt", "typed", "\nmake it faster"],
      ["system", "system-reminder", "be nice"],
    ]);
  });

  it("keeps pasted content verbatim, including injected-looking tags", () => {
    const text =
      '<pasted_content id="ab12">\nsee <system-reminder>x</system-reminder> here\n</pasted_content id="ab12">';
    expect(labels(text)).toEqual([
      ["prompt", "pasted", "see <system-reminder>x</system-reminder> here"],
    ]);
  });

  it("runs an unclosed pasted_content to the end of the text", () => {
    expect(labels('look: <pasted_content id="1">\nline one\nline two')).toEqual([
      ["prompt", "typed", "look: "],
      ["prompt", "pasted", "line one\nline two"],
    ]);
  });

  it("turns slash commands into /name args", () => {
    const text =
      "<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>123</command-args>";
    expect(segmentUserText(text).filter((s) => s.text.trim())).toEqual([
      { label: "prompt", source: "slash_command", text: "/review 123" },
    ]);
  });

  it("prefixes bash-mode input with !", () => {
    expect(labels("<bash-input>ls -la</bash-input>")).toEqual([["prompt", "bash", "!ls -la"]]);
  });

  it("labels interrupts as system", () => {
    expect(labels("[Request interrupted by user for tool use]")).toEqual([
      ["system", "interrupt", "[Request interrupted by user for tool use]"],
    ]);
  });

  it("drops empty injected tags", () => {
    expect(labels("<system-reminder>  </system-reminder>hi")).toEqual([["prompt", "typed", "hi"]]);
  });
});

describe("mergePromptSegments", () => {
  it("merges typed and pasted parts into one prompt at the first typed position", () => {
    const merged = mergePromptSegments(
      segmentUserText(
        '<system-reminder>r</system-reminder>do this: <pasted_content id="1">\nabc\n</pasted_content id="1"> thanks',
      ),
    );
    expect(merged).toEqual([
      { label: "system", source: "system-reminder", text: "r" },
      { label: "prompt", text: "do this: \nabc\n thanks", sources: ["typed", "pasted"] },
    ]);
  });

  it("returns no prompt when nothing was typed", () => {
    expect(mergePromptSegments(segmentUserText("<system-reminder>r</system-reminder>\n"))).toEqual([
      { label: "system", source: "system-reminder", text: "r" },
    ]);
  });
});
