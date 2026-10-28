import assert from "node:assert/strict";
import test from "node:test";
import { checkTaskGraph } from "../src/graph-check.js";

function task(ref: string) {
  return { ref, type: "task", attributes: { title: ref, description: "D", estimated_minutes: 60, estimate_source: "ai" } };
}

function graph(tasks: string[], links: [string, string][]) {
  return {
    schema_version: "task-graph-version/v1",
    graph: {
      nodes: [...tasks.map(task), { ref: "n_SUMMARY", type: "summary", attributes: { title: "Goal" } }],
      edges: links.map(([source, target], index) => ({ ref: `e_EDGE${String(index).padStart(3, "0")}`, source, target })),
    },
  };
}

test("the initial empty graph is publishable", () => {
  assert.deepEqual(
    checkTaskGraph({ schema_version: "task-graph-version/v1", graph: { nodes: [], edges: [] } }),
    { publishable: true, errors: [], warnings: [] },
  );
});

test("a staged chain links only its terminal task to the summary", () => {
  const result = checkTaskGraph(graph(["n_STAGE1", "n_STAGE2", "n_STAGE3"], [
    ["n_STAGE1", "n_STAGE2"], ["n_STAGE2", "n_STAGE3"], ["n_STAGE3", "n_SUMMARY"],
  ]));
  assert.deepEqual(result, { publishable: true, errors: [], warnings: [] });
});

test("summary shortcuts and implied edges stay publishable but are flagged", () => {
  const result = checkTaskGraph(graph(["n_STAGE1", "n_STAGE2", "n_STAGE3"], [
    ["n_STAGE1", "n_STAGE2"], ["n_STAGE2", "n_STAGE3"], ["n_STAGE3", "n_SUMMARY"],
    ["n_STAGE1", "n_SUMMARY"], ["n_STAGE1", "n_STAGE3"],
  ]));
  assert.equal(result.publishable, true);
  assert.deepEqual(result.warnings.map((finding) => [finding.code, finding.refs]), [
    ["redundant_edge", ["e_EDGE003"]],
    ["redundant_edge", ["e_EDGE004"]],
  ]);
  assert.match(result.warnings[0]!.message, /directly to the summary although it already reaches it through n_STAGE2/);
});

test("publication rule violations are errors", () => {
  const unreachable = checkTaskGraph(graph(["n_STAGE1", "n_STAGE2"], [["n_STAGE2", "n_SUMMARY"]]));
  assert.equal(unreachable.publishable, false);
  assert.deepEqual(unreachable.errors.map((finding) => [finding.code, finding.refs]), [["task_unreachable", ["n_STAGE1"]]]);

  const cyclic = checkTaskGraph(graph(["n_STAGE1", "n_STAGE2"], [
    ["n_STAGE1", "n_STAGE2"], ["n_STAGE2", "n_STAGE1"], ["n_STAGE2", "n_SUMMARY"],
  ]));
  assert.deepEqual(cyclic.errors.map((finding) => finding.code), ["cycle"]);

  const malformed = checkTaskGraph(graph(["n_STAGE1"], [
    ["n_STAGE1", "n_SUMMARY"], ["n_STAGE1", "n_SUMMARY"], ["n_STAGE1", "n_STAGE1"],
    ["n_SUMMARY", "n_STAGE1"], ["n_STAGE1", "n_MISSING"],
  ]));
  assert.deepEqual(malformed.errors.map((finding) => finding.code), [
    "duplicate_edge", "self_loop", "missing_endpoint", "summary_outgoing", "cycle",
  ]);
});

test("node attribute rules match Hub publication", () => {
  const payload = graph(["n_STAGE1"], [["n_STAGE1", "n_SUMMARY"]]);
  payload.graph.nodes[0]!.attributes = { title: " ", description: "", estimated_minutes: 60, estimate_source: null } as never;
  payload.graph.nodes.push({ ref: "n_SUMMARY2", type: "summary", attributes: { title: "Again" } });
  assert.deepEqual(checkTaskGraph(payload).errors.map((finding) => finding.code), [
    "blank_title", "blank_description", "estimate_pair", "summary_count",
  ]);
});
