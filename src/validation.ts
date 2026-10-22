import { readFile } from "node:fs/promises";
import { TASK_GRAPH_VERSION_SCHEMA } from "./tool.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NODE_REF = /^n_[A-Z0-9]{6,61}$/;
const EDGE_REF = /^e_[A-Z0-9]{6,61}$/;
const MAX_INPUT_BYTES = 16 << 20;

export const deliveryRequestStatuses = ["planning", "developing", "completed"] as const;
export const organizationStatuses = ["active", "suspended", "archived"] as const;

export function required(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required`);
  return value;
}

export function requiredUUID(name: string, value: unknown): string {
  const result = required(name, value);
  if (!UUID.test(result)) throw new Error(`--${name} must be a UUID`);
  return result;
}

export function optionalUUID(name: string, value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  return requiredUUID(name, value);
}

export function requiredNodeRef(value: unknown): string {
  const result = required("node-ref", value);
  if (!NODE_REF.test(result)) throw new Error("--node-ref must match ^n_[A-Z0-9]{6,61}$");
  return result;
}

export function enumValue(name: string, value: unknown, allowed: readonly string[]): string {
  const result = required(name, value);
  if (!allowed.includes(result)) throw new Error(`--${name} must be one of: ${allowed.join(", ")}`);
  return result;
}

export function nonNegativeInteger(name: string, value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`--${name} must be a non-negative integer`);
  return number;
}

export function pageQuery(options: { limit?: unknown; cursor?: unknown }): URLSearchParams {
  const limit = options.limit == null ? 20 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit must be between 1 and 100");
  const query = new URLSearchParams({ limit: String(limit) });
  if (typeof options.cursor === "string" && options.cursor) query.set("cursor", options.cursor);
  return query;
}

export async function readJSONObject(path: unknown): Promise<Record<string, unknown>> {
  const input = required("input", path);
  const contents = input === "-" ? await readStdin() : await readFile(input);
  if (contents.byteLength > MAX_INPUT_BYTES) throw new Error("--input exceeds 16 MiB");
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error("--input must contain exactly one JSON object");
  }
  if (!isObject(value)) throw new Error("--input must contain one JSON object");
  return value;
}

export async function readTaskGraphVersion(path: unknown): Promise<Record<string, unknown>> {
  const payload = await readJSONObject(path);
  onlyFields(payload, ["schema_version", "graph"], "--input");
  if (payload.schema_version !== TASK_GRAPH_VERSION_SCHEMA) {
    throw new Error(`--input schema_version must be ${JSON.stringify(TASK_GRAPH_VERSION_SCHEMA)}`);
  }
  if (!isObject(payload.graph)) throw new Error("--input graph must contain nodes and edges arrays");
  onlyFields(payload.graph, ["nodes", "edges"], "--input graph");
  if (!Array.isArray(payload.graph.nodes)) throw new Error("--input graph.nodes must be an array");
  if (!Array.isArray(payload.graph.edges)) throw new Error("--input graph.edges must be an array");
  if (payload.graph.nodes.length > 2_000 || payload.graph.edges.length > 10_000) {
    throw new Error("--input task graph exceeds node or edge limits");
  }
  const nodeRefs = new Set<string>();
  payload.graph.nodes.forEach((node, index) => {
    const ref = validateNode(node, index);
    if (nodeRefs.has(ref)) throw new Error(`--input graph.nodes[${index}]: duplicate ref ${JSON.stringify(ref)}`);
    nodeRefs.add(ref);
  });
  const edgeRefs = new Set<string>();
  payload.graph.edges.forEach((edge, index) => {
    const ref = validateEdge(edge, index);
    if (edgeRefs.has(ref)) throw new Error(`--input graph.edges[${index}]: duplicate ref ${JSON.stringify(ref)}`);
    edgeRefs.add(ref);
  });
  return payload;
}

function validateNode(value: unknown, index: number): string {
  const prefix = `--input graph.nodes[${index}]`;
  if (!isObject(value)) throw new Error(`${prefix}: must be an object`);
  onlyFields(value, ["ref", "type", "attributes"], prefix);
  if (typeof value.ref !== "string" || !NODE_REF.test(value.ref)) throw new Error(`${prefix}: ref must match ^n_[A-Z0-9]{6,61}$`);
  if (value.type !== "task" && value.type !== "summary") throw new Error(`${prefix}: type must be "task" or "summary"`);
  if (!isObject(value.attributes)) throw new Error(`${prefix}: attributes must be an object`);
  if (value.type === "summary") {
    onlyFields(value.attributes, ["title"], `${prefix} attributes`);
    boundedString(value.attributes.title, 255, `${prefix} attributes.title`);
    return value.ref;
  }
  onlyFields(value.attributes, ["title", "description", "estimated_minutes", "estimate_source"], `${prefix} attributes`);
  boundedString(value.attributes.title, 255, `${prefix} attributes.title`);
  boundedString(value.attributes.description, 20_000, `${prefix} attributes.description`);
  const minutes = value.attributes.estimated_minutes;
  if (minutes !== null && (!Number.isInteger(minutes) || (minutes as number) < 0 || (minutes as number) > 2_147_483_647)) {
    throw new Error(`${prefix}: attributes.estimated_minutes must be null or an integer between 0 and 2147483647`);
  }
  const source = value.attributes.estimate_source;
  if (source !== null && source !== "manual" && source !== "ai") {
    throw new Error(`${prefix}: attributes.estimate_source must be null or one of: manual, ai`);
  }
  return value.ref;
}

function validateEdge(value: unknown, index: number): string {
  const prefix = `--input graph.edges[${index}]`;
  if (!isObject(value)) throw new Error(`${prefix}: must be an object`);
  onlyFields(value, ["ref", "source", "target"], prefix);
  if (typeof value.ref !== "string" || !EDGE_REF.test(value.ref)) throw new Error(`${prefix}: ref must match ^e_[A-Z0-9]{6,61}$`);
  for (const field of ["source", "target"] as const) {
    if (typeof value[field] !== "string" || !NODE_REF.test(value[field])) {
      throw new Error(`${prefix}: ${field} must match ^n_[A-Z0-9]{6,61}$`);
    }
  }
  return value.ref;
}

function onlyFields(value: Record<string, unknown>, fields: string[], prefix: string): void {
  for (const field of fields) if (!(field in value)) throw new Error(`${prefix}: missing required field ${JSON.stringify(field)}`);
  const allowed = new Set(fields);
  for (const field of Object.keys(value)) if (!allowed.has(field)) throw new Error(`${prefix}: unknown field ${JSON.stringify(field)}`);
}

function boundedString(value: unknown, maximum: number, prefix: string): void {
  if (typeof value !== "string") throw new Error(`${prefix} must be a string`);
  if ([...value].length > maximum) throw new Error(`${prefix} must contain at most ${maximum} characters`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > MAX_INPUT_BYTES) throw new Error("--input exceeds 16 MiB");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
