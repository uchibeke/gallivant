import { PLAN_LIMITS, PLAN_VERSION, planError } from "./dependency_plan_limits.mjs";

function commonScope(from, to) {
  let a = from.parent, b = to.parent;
  while (a !== b) {
    if (a.depth >= b.depth) a = a.parent;
    else b = b.parent;
  }
  return a;
}

function assertAcyclic(leaves, outgoing) {
  const visited = new Set(), active = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    active.add(id);
    for (const [next, at] of outgoing.get(id) ?? []) {
      if (active.has(next)) throw planError(at, `dependency cycle from ${id} to ${next}`);
      visit(next);
    }
    active.delete(id);
    visited.add(id);
  }
  for (const { id } of leaves) visit(id);
}

// Work within the scope shared by each pair of dependency endpoints. A
// group's own prerequisites and edges crossing its scope cannot change its
// entry/exit sets. Edges within it, including between deeply nested siblings,
// contribute to the sets before an enclosing scope uses them.
export function dependencyGraph(name, at, mode = "parallel") {
  const root = { id: "", depth: 0, mode, children: [], links: [], at };
  const index = new Map(), owners = new Map(), leaves = [], outgoing = new Map();
  let tasks = 0, references = 0, edges = 0, attempts = 0, previewBytes = 0;

  function add(parent, { id: localId, ...value }, source, needs = []) {
    const id = parent.id ? `${parent.id}/${localId}` : localId;
    const depth = parent.depth + 1;
    if (depth > PLAN_LIMITS.depth) throw planError(source, "exceeds the plan node depth limit of 32");
    if (index.size >= PLAN_LIMITS.nodes) throw planError(source, "exceeds the 1,000-node limit");
    if (index.has(id)) throw planError(source, `duplicate node ID ${id}`);
    references += needs.length;
    if (references > PLAN_LIMITS.references) throw planError(source, "exceeds the 10,000 needs references limit");

    const node = { id, parent, depth, at: source, needs };
    if (value.type === "group") Object.assign(node, { mode: value.mode, children: [], links: [] });
    else {
      if (value.type === "task") {
        const first = owners.get(value.taskId);
        if (first) throw planError(source, `duplicate canonical task identity ${value.taskId} (first declared at ${first})`);
        owners.set(value.taskId, source);
        tasks++;
      }
      node.value = { id, ...value };
      leaves.push(node.value);
    }
    parent.children.push(node);
    index.set(id, node);
    return node;
  }

  function chargePreview(id, source) {
    // Qualified IDs are ASCII. Charge repeated IDs during expansion to bound
    // serialization work, then check the complete encoded preview separately.
    previewBytes += id.length + 3;
    if (previewBytes > PLAN_LIMITS.previewBytes) throw planError(source, "exceeds the 4 MiB normalized preview limit");
  }

  function addEdge(from, to, source) {
    if (++attempts > PLAN_LIMITS.edgeAttempts) throw planError(source, "dependency expansion exceeds the 100,000 edge attempts limit");
    if (!outgoing.has(from)) outgoing.set(from, new Map());
    const targets = outgoing.get(from);
    if (targets.has(to)) return;
    if (++edges > PLAN_LIMITS.edges) throw planError(source, "exceeds the 10,000-edge limit");
    chargePreview(from, source);
    chargePreview(to, source);
    targets.set(to, source);
  }

  function expand(node) {
    if (node.value) {
      node.entries = node.exits = [node.id];
      return { id: node.id, type: node.value.type };
    }
    if (!node.children.length) throw planError(node.at, node === root ? "plan must contain at least one node" : "group must contain at least one child");
    const children = node.children.map(expand);
    const entries = new Set(), exits = new Set();
    for (const child of node.children) {
      for (const entry of child.entries) entries.add(entry);
      for (const exit of child.exits) exits.add(exit);
    }
    if (node.mode === "sequence") {
      for (let i = 1; i < node.children.length; i++) {
        node.links.push({ from: node.children[i - 1], to: node.children[i], at: node.children[i].at });
      }
    }
    for (const link of node.links) {
      for (const from of link.from.exits) {
        for (const to of link.to.entries) {
          addEdge(from, to, link.at);
          entries.delete(to);
          exits.delete(from);
        }
      }
    }
    node.entries = [...entries].sort();
    node.exits = [...exits].sort();
    for (const id of node.entries) chargePreview(id, node.at);
    for (const id of node.exits) chargePreview(id, node.at);
    return { id: node.id, type: "group", mode: node.mode, entries: node.entries, exits: node.exits, children };
  }

  function finish() {
    for (const to of index.values()) {
      const linked = new Set();
      for (const { ref, at: source } of to.needs) {
        const id = ref.startsWith("/") ? ref.slice(1) : ref.includes("/") || !to.parent.id ? ref : `${to.parent.id}/${ref}`;
        const from = index.get(id);
        if (!from) throw planError(source, `unresolved local needs reference ${ref}`);
        if (from === to || to.id.startsWith(`${from.id}/`) || from.id.startsWith(`${to.id}/`)) {
          throw planError(source, `dependency cycle between ${from.id} and ${to.id}`);
        }
        if (linked.has(from)) continue;
        linked.add(from);
        commonScope(from, to).links.push({ from, to, at: source });
      }
    }
    const { children: hierarchy, entries, exits } = expand(root);
    if (!tasks) throw planError(at, "plan must contain at least one executable task");
    assertAcyclic(leaves, outgoing);
    const sortedEdges = [];
    for (const from of [...outgoing.keys()].sort()) {
      for (const to of [...outgoing.get(from).keys()].sort()) sortedEdges.push({ from, to });
    }
    return { version: PLAN_VERSION, name, dependency: "integrated", nodes: leaves, edges: sortedEdges, entries, exits, hierarchy };
  }

  return { root, add, finish };
}
