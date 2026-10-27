# Task Graph protocol

> **Important:** [graph-document.v3.schema.json](graph-document.v3.schema.json) and [task-graph-version.v1.schema.json](task-graph-version.v1.schema.json) are the authoritative protocol and common foundation for every Wayline Task Graph communication. Hub, frontend, CLI, and Skill must follow them and must not maintain a private parallel structure.

These files are byte-identical release mirrors of the backend protocol source. Their canonical SHA-256 values are recorded in [protocol-manifest.json](protocol-manifest.json). Do not edit a local Skill copy.

## Consumption rules

1. Read `schema_version` before interpreting a graph.
2. Hub reads return `graph-document/v3`; submissions accept `task-graph-version/v1`.
3. A version contains graph design only. Do not include execution status, assignees, priority, schedules, comments, or Delivery Request display text.
4. Preserve every surviving node and edge `ref`; never reuse a deleted ref or change the type attached to a ref.
5. A `graph-document/v3` read projection cannot be submitted directly. Remove `graph_id`, `published_version_id`, all node `metadata`, and edge `attributes`, then wrap nodes and edges in `task-graph-version/v1`.
6. Envelopes may carry request metadata, but the graph object must conform exactly to its Schema.

## Semantic rules

JSON Schema is not sufficient by itself. A candidate entering approval or publication must also have unique refs, valid edge endpoints, no self-loop or duplicate endpoint pair, no cycle, exactly one summary sink unless the graph is the initial empty graph, and a path from every task to that summary. Task title and description cannot be whitespace-only. `estimated_minutes` and `estimate_source` must both be null or both be non-null.

Published protocol versions are immutable. Add a new schema version for semantic changes and migrate readers before writers.
