import { describe, expect, it } from "vitest";
import { repairDiagram } from "./diagram";

describe("putting a diagram's source right", () => {
  it("leaves good source as it is", () => {
    const good = "flowchart LR\n  A[Start] -->|yes| B[End]\n  B --> C{Done?}";
    expect(repairDiagram(good)).toBe(good);
  });

  it("turns a written \\n into a line break and drops an arrow to nowhere, keeping its words", () => {
    const written = [
      "flowchart LR",
      "  M[Main\\nall three] --> A[Cut the periods\\nequal weights]\\n--> how much is left?",
      "  A --> R[Whichever goes to zero\\nwas no alpha]",
    ].join("\n");
    expect(repairDiagram(written)).toBe(
      [
        "flowchart LR",
        "  M[Main<br/>all three] --> A[Cut the periods<br/>equal weights<br/>how much is left?]",
        "  A --> R[Whichever goes to zero<br/>was no alpha]",
      ].join("\n"),
    );
  });

  it("takes fences off", () => {
    expect(repairDiagram("```mermaid\nflowchart TD\n  A --> B\n```")).toBe(
      "flowchart TD\n  A --> B",
    );
  });

  it("never folds a node an arrow leads to into the node before it", () => {
    // A line break written before a real arrow: the break goes, the arrow stays.
    expect(repairDiagram("A[x]\\n--> B[y]")).toBe("A[x] --> B[y]");
    expect(repairDiagram("A[x]<br/>--> B[y]")).toBe("A[x] --> B[y]");
    expect(repairDiagram("A[x] --> B[y]\\n--> C[z]")).toBe("A[x] --> B[y] --> C[z]");
    expect(repairDiagram("B{y}\\n-- label --> C")).toBe("B{y} -- label --> C");
    expect(repairDiagram("A[x]\\n-->|yes| B")).toBe("A[x] --> |yes| B");
    expect(repairDiagram("A[x]\\n--> done")).toBe("A[x] --> done");
    // An open link, and an arrow still being written, lose nothing but the break.
    expect(repairDiagram("A[x]\\n---")).toBe("A[x] ---");
    expect(repairDiagram("A[x]\\n--> ")).toBe("A[x] -->");
    // A subgraph's line is left alone.
    expect(repairDiagram("subgraph S[Group]\\n--> more words here")).toBe(
      "subgraph S[Group]\\n--> more words here",
    );
  });

  it("turns a written \\n into a break only inside a label", () => {
    expect(repairDiagram('A["one\\ntwo"] -->|a\\nb| B(c\\nd)')).toBe(
      'A["one<br/>two"] -->|a<br/>b| B(c<br/>d)',
    );
    expect(repairDiagram("title Plan\\nfor Q4")).toBe("title Plan\\nfor Q4");
  });
});
