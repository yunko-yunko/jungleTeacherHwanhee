'use strict';

function buildUndirectedGraph(nodes, edges) {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new TypeError('Nodes and edges must be arrays.');
  const graph = new Map();
  for (const node of nodes) {
    const id = typeof node === 'string' ? node : node?.id;
    if (typeof id !== 'string' || !id || graph.has(id)) throw new TypeError('Node IDs must be unique non-empty strings.');
    graph.set(id, new Map());
  }
  for (const edge of edges) {
    if (!graph.has(edge.from) || !graph.has(edge.to)) throw new RangeError('Edge references an unknown node.');
    if (!Number.isFinite(edge.weight) || edge.weight < 0) throw new RangeError('Dijkstra requires non-negative finite weights.');
    const previous = graph.get(edge.from).get(edge.to) ?? Infinity;
    const weight = Math.min(previous, edge.weight);
    graph.get(edge.from).set(edge.to, weight);
    graph.get(edge.to).set(edge.from, weight);
  }
  return graph;
}

class MinHeap {
  constructor() { this.items = []; }
  push(item) {
    let index = this.items.push(item) - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].distance <= item.distance) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }
  pop() {
    if (!this.items.length) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (!this.items.length) return first;
    let index = 0;
    while (index * 2 + 1 < this.items.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.items.length && this.items[child + 1].distance < this.items[child].distance) child++;
      if (last.distance <= this.items[child].distance) break;
      this.items[index] = this.items[child];
      index = child;
    }
    this.items[index] = last;
    return first;
  }
}

function dijkstra(graph, start) {
  if (!(graph instanceof Map) || !graph.has(start)) throw new RangeError('Unknown start node.');
  for (const neighbors of graph.values()) {
    if (!(neighbors instanceof Map)) throw new TypeError('Graph adjacency must be a Map.');
    for (const [id, weight] of neighbors) {
      if (!graph.has(id) || !Number.isFinite(weight) || weight < 0) throw new RangeError('Invalid graph edge.');
    }
  }
  const distances = new Map([...graph.keys()].map(id => [id, Infinity]));
  const previous = new Map();
  const heap = new MinHeap();
  distances.set(start, 0);
  heap.push({ id: start, distance: 0 });
  while (heap.items.length) {
    const current = heap.pop();
    // A shorter route may have entered the heap since this item was queued.
    if (current.distance !== distances.get(current.id)) continue;
    for (const [neighbor, weight] of graph.get(current.id)) {
      const candidate = current.distance + weight;
      if (candidate < distances.get(neighbor)) {
        distances.set(neighbor, candidate);
        previous.set(neighbor, current.id);
        heap.push({ id: neighbor, distance: candidate });
      }
    }
  }
  return { distances, previous };
}

function reconstructPath(result, start, target) {
  if (!Number.isFinite(result.distances.get(target))) return [];
  const path = [target];
  while (path[0] !== start) {
    const parent = result.previous.get(path[0]);
    if (parent === undefined) return [];
    path.unshift(parent);
  }
  return path;
}

function shortestPath(graph, start, target) {
  if (!graph.has(target)) throw new RangeError('Unknown target node.');
  const result = dijkstra(graph, start);
  return { distance: result.distances.get(target), path: reconstructPath(result, start, target) };
}

module.exports = { buildUndirectedGraph, dijkstra, shortestPath, reconstructPath };
