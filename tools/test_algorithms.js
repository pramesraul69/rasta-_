/* Node harness: cross-checks the four algorithms on the real graph.
 *
 *   node tools/test_algorithms.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

global.window = global;
global.performance = performance;
require(path.join(__dirname, '..', 'js', 'algorithms.js'));

const raw = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'graph.json'), 'utf8')
);
const graph = new window.RastaGraph.RoadGraph(raw);
const algorithms = ['dijkstra', 'astar', 'bellman', 'bidir'];

console.log(`graph: ${graph.n} nodes, ${graph.m} directed edges, ` +
  `vmax ${(graph.vmax * 3.6).toFixed(1)} km/h`);

function pathIsValid(result) {
  if (!result.found) return false;
  if (result.path.length === 0) return false;
  if (result.path.length === 1) return true;
  if (result.edges.length !== result.path.length - 1) return false;
  let distance = 0;
  let duration = 0;
  for (let i = 0; i < result.edges.length; i++) {
    const e = result.edges[i];
    if (graph.eFrom[e] !== result.path[i]) return false;
    if (graph.eTo[e] !== result.path[i + 1]) return false;
    distance += graph.eDist[e];
    duration += graph.eTime[e];
  }
  return Math.abs(distance - result.distance) < 0.05 &&
    Math.abs(duration - result.duration) < 0.05;
}

let failures = 0;
const pairs = [];
for (let i = 0; i < 6; i++) {
  const source = (i * 6007 + 123) % graph.n;
  const target = (i * 11003 + 4567) % graph.n;
  if (source !== target) pairs.push([source, target]);
}

for (const mode of ['distance', 'time']) {
  for (const [source, target] of pairs) {
    const results = {};
    for (const name of algorithms) {
      results[name] = graph.route(name, source, target, mode, new Set());
    }
    const reference = results.dijkstra;
    if (!reference.found) {
      console.log(`pair ${source}→${target} (${mode}): unreachable, skipped`);
      continue;
    }
    for (const name of algorithms) {
      const result = results[name];
      const weight = mode === 'time' ? result.duration : result.distance;
      const referenceWeight = mode === 'time'
        ? reference.duration : reference.distance;
      const tolerance = Math.max(0.05, referenceWeight * 1e-9);
      if (!result.found || !pathIsValid(result)) {
        failures += 1;
        console.error(`FAIL ${name} ${source}→${target} (${mode}): invalid path`);
      } else if (Math.abs(weight - referenceWeight) > tolerance) {
        failures += 1;
        console.error(`FAIL ${name} ${source}→${target} (${mode}): ` +
          `${weight} vs ${referenceWeight}`);
      }
    }
    console.log(
      `pair ${String(source).padStart(5)}→${String(target).padStart(5)} ` +
      `(${mode.padEnd(8)}) ` +
      `${(reference.distance / 1000).toFixed(2)} km  ` +
      algorithms.map((name) =>
        `${name}: ${results[name].runtimeMs.toFixed(1)} ms/${results[name].explored}`
      ).join('  ')
    );
  }
}

// Blocked-edge sanity check: blocking an edge used by the route must not
// produce a path that still uses it.
const pair = pairs[0];
const base = graph.route('dijkstra', pair[0], pair[1], 'distance', new Set());
if (base.found && base.edges.length) {
  const blocked = new Set([base.edges[Math.floor(base.edges.length / 2)]]);
  const detour = graph.route('dijkstra', pair[0], pair[1], 'distance', blocked);
  if (detour.found && detour.edges.some((e) => blocked.has(e))) {
    failures += 1;
    console.error('FAIL blocked edge still used by the detour');
  } else {
    console.log('blocked-edge check: ok');
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll algorithm checks passed.');
