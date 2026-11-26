/**
 * Where the boxes and bands of a flow diagram lie (a Sankey): amounts going from sources
 * to uses, each box as tall as what passes through it, each band as thick as its amount.
 * Pure arithmetic, shared by every client that draws it, so one reply is one drawing.
 */

export interface Flow {
  from: string;
  to: string;
  value: number;
}

export interface FlowNode {
  name: string;
  /** Which column it stands in, from the left, and of how many. */
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** What passes through it: the larger of what comes in and what goes out. */
  value: number;
}

export interface FlowBand {
  from: string;
  to: string;
  value: number;
  /** Its left end (the right edge of its source) and its right end, by their middles. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  thickness: number;
}

export interface FlowLayout {
  columns: number;
  nodes: FlowNode[];
  bands: FlowBand[];
}

/** How much a drawing holds. */
export const FLOWS_MOST = { flows: 40, nodes: 24 } as const;

/**
 * Lays the flows out in a box. A flow that is not a positive amount between two different
 * names is left out; one that would close a circle is left out too, since a circle has no
 * left and right. Names with nothing coming in stand at the left, names with nothing going
 * out at the right, the rest as far right as what feeds them.
 */
export function layoutFlows(
  given: Flow[],
  width: number,
  height: number,
  { bar = 10, gap = 10 }: { bar?: number; gap?: number } = {},
): FlowLayout {
  const empty: FlowLayout = { columns: 0, nodes: [], bands: [] };
  if (!(width > 0) || !(height > 0)) return empty;
  const names: string[] = [];
  const kept: Flow[] = [];
  // What each name reaches so far, to refuse a flow that would lead back to its own start.
  const next = new Map<string, Set<string>>();
  const reaches = (start: string, goal: string): boolean => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const at = stack.pop() as string;
      if (at === goal) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      for (const to of next.get(at) ?? []) stack.push(to);
    }
    return false;
  };
  for (const flow of given) {
    if (kept.length >= FLOWS_MOST.flows) break;
    if (!flow || typeof flow.from !== "string" || typeof flow.to !== "string") continue;
    const from = flow.from.trim();
    const to = flow.to.trim();
    if (!from || !to || from === to) continue;
    if (typeof flow.value !== "number" || !Number.isFinite(flow.value) || flow.value <= 0) continue;
    if (reaches(to, from)) continue;
    const fresh = [from, to].filter((name) => !names.includes(name));
    if (names.length + new Set(fresh).size > FLOWS_MOST.nodes) continue;
    for (const name of fresh) if (!names.includes(name)) names.push(name);
    kept.push({ from, to, value: flow.value });
    next.set(from, (next.get(from) ?? new Set()).add(to));
  }
  if (!kept.length) return empty;

  // Columns: as far right as the longest way in. No circles are left, so this ends.
  const column = new Map<string, number>(names.map((name) => [name, 0]));
  for (let pass = 0; pass < names.length; pass += 1) {
    let moved = false;
    for (const flow of kept) {
      const want = (column.get(flow.from) ?? 0) + 1;
      if ((column.get(flow.to) ?? 0) < want) {
        column.set(flow.to, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const last = Math.max(...column.values());
  // What nothing leaves stands at the right edge, where a reader looks for where it all went.
  for (const name of names) if (!next.has(name)) column.set(name, last);
  const columns = last + 1;

  const into = new Map<string, number>();
  const out = new Map<string, number>();
  for (const flow of kept) {
    into.set(flow.to, (into.get(flow.to) ?? 0) + flow.value);
    out.set(flow.from, (out.get(flow.from) ?? 0) + flow.value);
  }
  const through = (name: string) => Math.max(into.get(name) ?? 0, out.get(name) ?? 0);
  const byColumn: string[][] = Array.from({ length: columns }, () => []);
  for (const name of names) byColumn[column.get(name) ?? 0]?.push(name);
  // One scale for all: the fullest column decides how tall a unit is.
  let scale = Number.POSITIVE_INFINITY;
  for (const members of byColumn) {
    if (!members.length) continue;
    const total = members.reduce((sum, name) => sum + through(name), 0);
    const room = height - gap * (members.length - 1);
    if (total > 0) scale = Math.min(scale, Math.max(1, room) / total);
  }
  if (!Number.isFinite(scale) || scale <= 0) return empty;

  const step = columns > 1 ? (width - bar) / (columns - 1) : 0;
  const nodes = new Map<string, FlowNode>();
  byColumn.forEach((members, at) => {
    const tall = members.reduce((sum, name) => sum + through(name) * scale, 0);
    let y = Math.max(0, (height - tall - gap * (members.length - 1)) / 2);
    for (const name of members) {
      const value = through(name);
      const h = Math.max(1, value * scale);
      nodes.set(name, { name, column: at, x: at * step, y, width: bar, height: h, value });
      y += h + gap;
    }
  });

  // Bands leave and arrive in the order of where they go and come from, so they cross least.
  const middle = (name: string) => {
    const node = nodes.get(name) as FlowNode;
    return node.y + node.height / 2;
  };
  const leaving = new Map<string, number>();
  const arriving = new Map<string, number>();
  const outOrder = [...kept].sort((a, b) => middle(a.to) - middle(b.to));
  const y0 = new Map<Flow, number>();
  for (const flow of outOrder) {
    const node = nodes.get(flow.from) as FlowNode;
    const used = leaving.get(flow.from) ?? 0;
    y0.set(flow, node.y + used + (flow.value * scale) / 2);
    leaving.set(flow.from, used + flow.value * scale);
  }
  const inOrder = [...kept].sort((a, b) => middle(a.from) - middle(b.from));
  const y1 = new Map<Flow, number>();
  for (const flow of inOrder) {
    const node = nodes.get(flow.to) as FlowNode;
    const used = arriving.get(flow.to) ?? 0;
    y1.set(flow, node.y + used + (flow.value * scale) / 2);
    arriving.set(flow.to, used + flow.value * scale);
  }
  const bands = kept.map((flow) => {
    const a = nodes.get(flow.from) as FlowNode;
    const b = nodes.get(flow.to) as FlowNode;
    return {
      from: flow.from,
      to: flow.to,
      value: flow.value,
      x0: a.x + a.width,
      y0: y0.get(flow) as number,
      x1: b.x,
      y1: y1.get(flow) as number,
      thickness: Math.max(1, flow.value * scale),
    };
  });
  return { columns, nodes: [...nodes.values()], bands };
}

/** The curve of a band between its two ends, as the middle line of a stroke that thick. */
export const bandPath = (band: FlowBand): string => {
  const mid = (band.x0 + band.x1) / 2;
  return `M${band.x0.toFixed(1)},${band.y0.toFixed(1)} C${mid.toFixed(1)},${band.y0.toFixed(1)} ${mid.toFixed(1)},${band.y1.toFixed(1)} ${band.x1.toFixed(1)},${band.y1.toFixed(1)}`;
};
