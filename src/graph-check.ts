interface GraphNode {
  ref: string;
  type: "task" | "summary";
  attributes: { title: string; description?: string; estimated_minutes?: number | null; estimate_source?: string | null };
}

interface GraphEdge {
  ref: string;
  source: string;
  target: string;
}

export interface GraphFinding {
  code: string;
  message: string;
  refs: string[];
}

export interface GraphCheck {
  publishable: boolean;
  errors: GraphFinding[];
  warnings: GraphFinding[];
}

// Mirrors the Hub publication rules, then lints the edge authoring rules Hub does not enforce.
// The payload must already have passed readTaskGraphVersion.
export function checkTaskGraph(payload: Record<string, unknown>): GraphCheck {
  const graph = payload.graph as { nodes: GraphNode[]; edges: GraphEdge[] };
  const errors: GraphFinding[] = [];
  const warnings: GraphFinding[] = [];
  const result = () => ({ publishable: errors.length === 0, errors, warnings });
  if (graph.nodes.length === 0 && graph.edges.length === 0) return result();

  const nodes = new Map(graph.nodes.map((node) => [node.ref, node]));
  for (const node of graph.nodes) {
    if (!node.attributes.title.trim()) {
      errors.push({ code: "blank_title", message: `node ${node.ref} has a blank title`, refs: [node.ref] });
    }
    if (node.type !== "task") continue;
    if (!node.attributes.description?.trim()) {
      errors.push({ code: "blank_description", message: `task ${node.ref} has a blank description`, refs: [node.ref] });
    }
    if ((node.attributes.estimated_minutes === null) !== (node.attributes.estimate_source === null)) {
      errors.push({
        code: "estimate_pair",
        message: `task ${node.ref} must set estimated_minutes and estimate_source together or leave both null`,
        refs: [node.ref],
      });
    }
  }
  const summaries = graph.nodes.filter((node) => node.type === "summary");
  if (summaries.length !== 1) {
    errors.push({
      code: "summary_count",
      message: `the graph must contain exactly one summary node, found ${summaries.length}`,
      refs: summaries.map((node) => node.ref),
    });
  }

  const outgoing = new Map(graph.nodes.map((node) => [node.ref, [] as GraphEdge[]]));
  const incoming = new Map(graph.nodes.map((node) => [node.ref, [] as GraphEdge[]]));
  const pairs = new Set<string>();
  for (const edge of graph.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
      errors.push({ code: "missing_endpoint", message: `edge ${edge.ref} references a node that does not exist`, refs: [edge.ref] });
      continue;
    }
    if (edge.source === edge.target) {
      errors.push({ code: "self_loop", message: `edge ${edge.ref} connects ${edge.source} to itself`, refs: [edge.ref] });
      continue;
    }
    const pair = `${edge.source}\n${edge.target}`;
    if (pairs.has(pair)) {
      errors.push({
        code: "duplicate_edge",
        message: `edge ${edge.ref} repeats ${edge.source} -> ${edge.target}`,
        refs: [edge.ref],
      });
      continue;
    }
    pairs.add(pair);
    outgoing.get(edge.source)!.push(edge);
    incoming.get(edge.target)!.push(edge);
  }
  const summary = summaries.length === 1 ? summaries[0]! : undefined;
  if (summary && outgoing.get(summary.ref)!.length > 0) {
    errors.push({
      code: "summary_outgoing",
      message: `summary ${summary.ref} must not have outgoing edges`,
      refs: outgoing.get(summary.ref)!.map((edge) => edge.ref),
    });
  }

  const degrees = new Map(graph.nodes.map((node) => [node.ref, incoming.get(node.ref)!.length]));
  const order = graph.nodes.filter((node) => degrees.get(node.ref) === 0).map((node) => node.ref);
  for (let i = 0; i < order.length; i++) {
    for (const edge of outgoing.get(order[i]!)!) {
      degrees.set(edge.target, degrees.get(edge.target)! - 1);
      if (degrees.get(edge.target) === 0) order.push(edge.target);
    }
  }
  if (order.length !== graph.nodes.length) {
    const ordered = new Set(order);
    errors.push({
      code: "cycle",
      message: "the graph contains a cycle",
      refs: graph.nodes.filter((node) => !ordered.has(node.ref)).map((node) => node.ref),
    });
    return result();
  }

  // Descendants per node, filled in reverse topological order.
  const descendants = new Map<string, Set<string>>();
  for (const ref of [...order].reverse()) {
    const reached = new Set<string>();
    for (const edge of outgoing.get(ref)!) {
      reached.add(edge.target);
      for (const next of descendants.get(edge.target)!) reached.add(next);
    }
    descendants.set(ref, reached);
  }
  if (summary) {
    for (const node of graph.nodes) {
      if (node.type === "task" && !descendants.get(node.ref)!.has(summary.ref)) {
        errors.push({
          code: "task_unreachable",
          message: `task ${node.ref} has no path to summary ${summary.ref}`,
          refs: [node.ref],
        });
      }
    }
  }

  for (const edge of graph.edges) {
    const siblings = outgoing.get(edge.source);
    if (!siblings?.includes(edge)) continue;
    const via = siblings.find((other) => other !== edge && descendants.get(other.target)!.has(edge.target));
    if (!via) continue;
    warnings.push({
      code: "redundant_edge",
      message: nodes.get(edge.target)!.type === "summary"
        ? `edge ${edge.ref} links ${edge.source} directly to the summary although it already reaches it through ${via.target}; remove it`
        : `edge ${edge.ref} (${edge.source} -> ${edge.target}) is implied by the path through ${via.target}; remove it`,
      refs: [edge.ref],
    });
  }
  return result();
}
