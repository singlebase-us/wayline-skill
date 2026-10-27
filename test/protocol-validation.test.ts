import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

import { readTaskGraphVersion } from "../src/validation.js";

type NodeRecord = { ref: string; type: string; attributes: Record<string, unknown> };
type EdgeRecord = { ref: string; source: string; target: string };
type GraphDocument = { schema_version: string; graph: { nodes: NodeRecord[]; edges: EdgeRecord[] } };

const schemaUrl = new URL("../protocol/task-graph-version.v1.schema.json", import.meta.url);
const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as { examples: unknown[] };
const ajv = new Ajv2020();
const checkSchema = ajv.compile(schema);
const baseline = structuredClone(schema.examples[0]) as GraphDocument;

const taskNode = (document: GraphDocument) => document.graph.nodes[0]!;
const summaryNode = (document: GraphDocument) => document.graph.nodes[1]!;
const edge = (document: GraphDocument) => document.graph.edges[0]!;

type Outcome = "both-accept" | "both-reject" | "cli-stricter";

const mutations: [string, (document: GraphDocument) => unknown][] = [
  ["shipped example", () => undefined],
  ["edge endpoint that names no existing node", (document) => (edge(document).target = "n_ABSENT1")],
  ["null minutes with a non-null estimate source", (document) => (taskNode(document).attributes.estimated_minutes = null)],
  ["duplicate node ref", (document) => document.graph.nodes.push(structuredClone(taskNode(document)))],
  ["duplicate edge ref", (document) => document.graph.edges.push(structuredClone(edge(document)))],
  ["astral title within the 255 code-point limit", (document) => (taskNode(document).attributes.title = `${"a".repeat(254)}\u{1F600}`)],
  ["unknown top-level field", (document) => ((document as Record<string, unknown>).control = true)],
  ["mismatched schema_version", (document) => (document.schema_version = "task-graph-version/v2")],
  ["missing graph", (document) => delete (document as Record<string, unknown>).graph],
  ["unexpected graph field", (document) => ((document.graph as Record<string, unknown>).metadata = {})],
  ["nodes is not an array", (document) => ((document.graph as Record<string, unknown>).nodes = {})],
  ["unsupported node type", (document) => (taskNode(document).type = "milestone")],
  ["lowercase node ref", (document) => (taskNode(document).ref = "n_login01")],
  ["short node ref", (document) => (taskNode(document).ref = "n_AB12")],
  ["edge ref is not an edge ref", (document) => (edge(document).ref = "n_LOGIN01")],
  ["edge source is not a node ref", (document) => (edge(document).source = "e_LOGIN01")],
  ["unknown task attribute", (document) => (taskNode(document).attributes.owner = "ada")],
  ["missing task attribute", (document) => delete taskNode(document).attributes.description],
  ["negative estimated minutes", (document) => (taskNode(document).attributes.estimated_minutes = -1)],
  ["fractional estimated minutes", (document) => (taskNode(document).attributes.estimated_minutes = 1.5)],
  ["estimated minutes above int32", (document) => (taskNode(document).attributes.estimated_minutes = 2_147_483_648)],
  ["estimated minutes as a string", (document) => (taskNode(document).attributes.estimated_minutes = "480")],
  ["unsupported estimate source", (document) => (taskNode(document).attributes.estimate_source = "auto")],
  ["summary node carrying task attributes", (document) => (summaryNode(document).attributes.description = "grouping")],
  ["title longer than 255", (document) => (taskNode(document).attributes.title = "a".repeat(256))],
  ["description longer than 20000", (document) => (taskNode(document).attributes.description = "a".repeat(20_001))],
  [
    "node count above the limit",
    (document) =>
      (document.graph.nodes = Array.from({ length: 2_001 }, (_unused, index) => ({
        ...structuredClone(taskNode(document)),
        ref: `n_NODE${String(index).padStart(6, "0")}`,
      }))),
  ],
  [
    "edge count above the limit",
    (document) =>
      (document.graph.edges = Array.from({ length: 10_001 }, (_unused, index) => ({
        ...structuredClone(edge(document)),
        ref: `e_EDGE${String(index).padStart(6, "0")}`,
      }))),
  ],
];

const expectations: Record<string, Outcome> = {
  "shipped example": "both-accept",
  "edge endpoint that names no existing node": "both-accept",
  "null minutes with a non-null estimate source": "both-accept",
  "duplicate node ref": "cli-stricter",
  "duplicate edge ref": "cli-stricter",
  "astral title within the 255 code-point limit": "both-accept",
};

test("the CLI validator and the shipped Task Graph schema decide every case the same way", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "wayline-protocol-validation-"));

  for (const [name, mutate] of mutations) {
    const document = structuredClone(baseline);
    mutate(document);
    const expect = expectations[name] ?? "both-reject";
    const acceptsSchema = checkSchema(document) as boolean;

    const path = resolve(directory, `${name.replace(/[^a-z0-9]+/gi, "-")}.json`);
    await writeFile(path, JSON.stringify(document));
    let cliError: unknown;
    try {
      await readTaskGraphVersion(path);
    } catch (error) {
      cliError = error;
    }

    switch (expect) {
      case "both-accept":
        assert.equal(acceptsSchema, true, `${name}: schema`);
        assert.equal(cliError, undefined, `${name}: CLI`);
        break;
      case "both-reject":
        assert.equal(acceptsSchema, false, `${name}: schema`);
        assert.notEqual(cliError, undefined, `${name}: CLI`);
        break;
      case "cli-stricter":
        assert.equal(acceptsSchema, true, `${name}: schema`);
        assert.notEqual(cliError, undefined, `${name}: CLI`);
        break;
    }
  }
});
