export const DIAGRAM_PAGE_SIZE = 24; // Plus the focused node on every page.
export const planNodeId = node => node.plan?.node ?? node.id;

// The picture is a window of the saved graph. A non-focused group is one
// endpoint, even if several of its members have an edge to the focus.
export function planNeighborhood(nodes, edges, focus, offset) {
  const groups = new Set(nodes.filter(node => node.type === "group").map(planNodeId));
  const center = planNodeId(focus);
  const endpoint = id => {
    const parts = id.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (groups.has(parent) && !center.startsWith(`${parent}/`)) return parent;
    }
    return id;
  };
  const representatives = nodes.filter(node => endpoint(planNodeId(node)) === planNodeId(node));
  const before = new Set(), after = new Set();
  for (const edge of edges) {
    const from = endpoint(edge.from), to = endpoint(edge.to);
    if (from === to) continue;
    if (to === center) before.add(from);
    if (from === center) after.add(to);
  }
  const compact = (node, relation) => ({ id: planNodeId(node), type: node.type, title: node.title ?? node.id,
    status: node.status, phase: node.phase, relation });
  const neighbors = representatives.flatMap(node => {
    const id = planNodeId(node);
    if (before.has(id)) return [compact(node, after.has(id) ? "both" : "before")];
    return after.has(id) ? [compact(node, "after")] : [];
  });
  const page = neighbors.slice(offset, offset + DIAGRAM_PAGE_SIZE);
  const focusNode = compact(focus, "focus");
  return { nodes: [...page.filter(node => node.relation !== "after"), focusNode, ...page.filter(node => node.relation === "after")],
    offset, total: neighbors.length, omitted: neighbors.length - page.length,
    outside: representatives.length - neighbors.length - 1, collapsed: nodes.length - representatives.length };
}
