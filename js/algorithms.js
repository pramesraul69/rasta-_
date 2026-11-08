/* Rasta — road graph + four shortest-path algorithms, written from scratch.
 *
 * Graph storage is CSR (compressed sparse row) over typed arrays so the
 * city-sized network stays fast in the browser.
 *
 *   graph.route('dijkstra' | 'astar' | 'bellman' | 'bidir', source, target,
 *               'distance' | 'time', blockedEdgeSet)
 */
(function (global) {
  'use strict';

  var EPS = 1e-9;

  /* ------------------------------------------------------------------ */
  /* Binary min-heap (priority queue)                                    */
  /* ------------------------------------------------------------------ */

  function MinHeap() {
    this.keys = [];
    this.vals = [];
  }

  MinHeap.prototype.size = function () {
    return this.keys.length;
  };

  MinHeap.prototype.push = function (key, val) {
    var keys = this.keys;
    var vals = this.vals;
    var i = keys.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      vals[i] = vals[parent];
      i = parent;
    }
    keys[i] = key;
    vals[i] = val;
  };

  MinHeap.prototype.pop = function () {
    var keys = this.keys;
    var vals = this.vals;
    var topKey = keys[0];
    var topVal = vals[0];
    var lastKey = keys.pop();
    var lastVal = vals.pop();
    var length = keys.length;
    if (length > 0) {
      var i = 0;
      while (true) {
        var child = 2 * i + 1;
        if (child >= length) break;
        if (child + 1 < length && keys[child + 1] < keys[child]) child += 1;
        if (keys[child] >= lastKey) break;
        keys[i] = keys[child];
        vals[i] = vals[child];
        i = child;
      }
      keys[i] = lastKey;
      vals[i] = lastVal;
    }
    return [topKey, topVal];
  };

  MinHeap.prototype.peekKey = function () {
    return this.keys[0];
  };

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  var EARTH_RADIUS = 6371008.8;

  function haversine(lat1, lon1, lat2, lon2) {
    var p1 = lat1 * Math.PI / 180;
    var p2 = lat2 * Math.PI / 180;
    var dp = p2 - p1;
    var dl = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dp / 2) * Math.sin(dp / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /* ------------------------------------------------------------------ */
  /* RoadGraph                                                           */
  /* ------------------------------------------------------------------ */

  function RoadGraph(raw) {
    var nodes = raw.nodes;
    var edges = raw.edges;
    var n = nodes.length;
    var m = edges.length;

    this.meta = raw.meta || {};
    this.nodes = nodes;
    this.roads = raw.roads || [];
    this.places = raw.places || [];
    this.n = n;
    this.m = m;

    this.eFrom = new Int32Array(m);
    this.eTo = new Int32Array(m);
    this.eDist = new Float32Array(m);
    this.eTime = new Float32Array(m);
    this.eRoad = new Int32Array(m);
    this.reverse = new Int32Array(m).fill(-1);

    var outCount = new Int32Array(n + 1);
    var inCount = new Int32Array(n + 1);
    var e;
    for (e = 0; e < m; e++) {
      var edge = edges[e];
      this.eFrom[e] = edge[0];
      this.eTo[e] = edge[1];
      this.eDist[e] = edge[2];
      this.eTime[e] = edge[3];
      this.eRoad[e] = edge[4];
      outCount[edge[0] + 1] += 1;
      inCount[edge[1] + 1] += 1;
    }

    this.outStart = new Int32Array(n + 1);
    this.inStart = new Int32Array(n + 1);
    for (var i = 0; i < n; i++) {
      this.outStart[i + 1] = this.outStart[i] + outCount[i + 1];
      this.inStart[i + 1] = this.inStart[i] + inCount[i + 1];
    }

    this.outEdges = new Int32Array(m);
    this.inEdges = new Int32Array(m);
    var outCursor = this.outStart.slice(0, n);
    var inCursor = this.inStart.slice(0, n);
    for (e = 0; e < m; e++) {
      this.outEdges[outCursor[this.eFrom[e]]++] = e;
      this.inEdges[inCursor[this.eTo[e]]++] = e;
    }

    // Maximum travel speed, used to keep the A* heuristic admissible in time mode.
    var vmax = 5;
    for (e = 0; e < m; e++) {
      if (this.eTime[e] > 0) {
        var speed = this.eDist[e] / this.eTime[e];
        if (speed > vmax) vmax = speed;
      }
    }
    this.vmax = vmax;

    // Reverse edge for each edge (same physical road, opposite direction).
    var lookup = new Map();
    for (e = 0; e < m; e++) {
      var key = edges[e][0] + ':' + edges[e][1] + ':' + edges[e][4];
      var list = lookup.get(key);
      if (!list) {
        list = [];
        lookup.set(key, list);
      }
      list.push(e);
    }
    for (e = 0; e < m; e++) {
      var reverseKey = edges[e][1] + ':' + edges[e][0] + ':' + edges[e][4];
      var reverseList = lookup.get(reverseKey);
      if (reverseList && reverseList.length) this.reverse[e] = reverseList[0];
    }

    // Mark nodes in the largest strongly connected component so that
    // nearestNode() only snaps to routable intersections.  One-way dead-ends
    // (about 1–2 % of the graph) are excluded to avoid "no route found" when
    // both endpoints are valid but separated by a directed cut.
    this.routable = this._buildSCC();
  }

  RoadGraph.prototype._buildSCC = function () {
    var n = this.n;
    var fwd = new Uint8Array(n);
    var bwd = new Uint8Array(n);
    var i, v, e;

    // Forward BFS from node 0.
    var queue = [0];
    fwd[0] = 1;
    while (queue.length) {
      v = queue.shift();
      for (i = this.outStart[v]; i < this.outStart[v + 1]; i++) {
        var u = this.eTo[this.outEdges[i]];
        if (!fwd[u]) { fwd[u] = 1; queue.push(u); }
      }
    }

    // Backward BFS from node 0.
    queue = [0];
    bwd[0] = 1;
    while (queue.length) {
      v = queue.shift();
      for (i = this.inStart[v]; i < this.inStart[v + 1]; i++) {
        var w = this.eFrom[this.inEdges[i]];
        if (!bwd[w]) { bwd[w] = 1; queue.push(w); }
      }
    }

    // Routable = forward ∩ backward (strongly connected to node 0).
    var routable = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      routable[i] = fwd[i] & bwd[i];
    }
    return routable;
  };

  RoadGraph.prototype.latLng = function (index) {
    return this.nodes[index];
  };

  RoadGraph.prototype.weight = function (mode, edge) {
    return mode === 'time' ? this.eTime[edge] : this.eDist[edge];
  };

  RoadGraph.prototype.nearestNode = function (lat, lon) {
    var nodes = this.nodes;
    var routable = this.routable;
    var kx = Math.cos(lat * Math.PI / 180) * 111320;
    var ky = 110540;
    var best = -1;
    var bestDistance = Infinity;
    for (var i = 0; i < this.n; i++) {
      if (!routable[i]) continue;
      var dx = (nodes[i][1] - lon) * kx;
      var dy = (nodes[i][0] - lat) * ky;
      var d2 = dx * dx + dy * dy;
      if (d2 < bestDistance) {
        bestDistance = d2;
        best = i;
      }
    }
    if (best < 0) return null;
    return { node: best, metres: Math.sqrt(bestDistance) };
  };

  RoadGraph.prototype.isEmpty = function (blocked) {
    return !blocked || blocked.size === 0;
  };

  /* Path helpers ------------------------------------------------------ */

  RoadGraph.prototype._result = function (name, source, target, mode, blocked, started) {
    var found = this._targetFound;
    var path = this._path || [];
    var edges = this._edges || [];
    var distance = 0;
    var duration = 0;
    for (var i = 0; i < edges.length; i++) {
      distance += this.eDist[edges[i]];
      duration += this.eTime[edges[i]];
    }
    return {
      algorithm: name,
      found: found,
      path: path,
      edges: edges,
      distance: distance,
      duration: duration,
      weight: found ? (mode === 'time' ? duration : distance) : Infinity,
      explored: this._explored,
      relaxations: this._relaxations,
      order: this._order,
      runtimeMs: performance.now() - started,
      mode: mode
    };
  };

  RoadGraph.prototype._rebuild = function (source, target, prev, prevEdge) {
    if (target === source) {
      this._targetFound = true;
      this._path = [source];
      this._edges = [];
      return;
    }
    if (prev[target] === -1) {
      this._targetFound = false;
      this._path = [];
      this._edges = [];
      return;
    }
    var path = [];
    var edges = [];
    var node = target;
    while (node !== -1) {
      path.push(node);
      if (prevEdge[node] !== -1) edges.push(prevEdge[node]);
      node = prev[node];
    }
    path.reverse();
    edges.reverse();
    this._targetFound = path.length > 0 && path[0] === source;
    this._path = path;
    this._edges = edges;
  };

  /* Dijkstra / A* ----------------------------------------------------- */

  RoadGraph.prototype._dijkstra = function (name, source, target, mode, blocked, heuristic) {
    var n = this.n;
    var dist = new Float64Array(n).fill(Infinity);
    var prev = new Int32Array(n).fill(-1);
    var prevEdge = new Int32Array(n).fill(-1);
    var settled = new Uint8Array(n);
    var heap = new MinHeap();
    var order = [];
    var targetLat = this.nodes[target][0];
    var targetLon = this.nodes[target][1];
    var vmax = this.vmax;

    dist[source] = 0;
    heap.push(0, source);

    while (heap.size() > 0) {
      var popped = heap.pop();
      var u = popped[1];
      if (settled[u]) continue;
      var d = dist[u];
      settled[u] = 1;
      order.push(u);
      if (u === target) break;

      var start = this.outStart[u];
      var end = this.outStart[u + 1];
      for (var k = start; k < end; k++) {
        var e = this.outEdges[k];
        if (blocked && blocked.size > 0 && blocked.has(e)) continue;
        var v = this.eTo[e];
        if (settled[v]) continue;
        var nd = d + this.weight(mode, e);
        if (nd + EPS < dist[v]) {
          dist[v] = nd;
          prev[v] = u;
          prevEdge[v] = e;
          var priority = nd;
          if (heuristic) {
            var h = haversine(this.nodes[v][0], this.nodes[v][1], targetLat, targetLon);
            priority += mode === 'time' ? h / vmax : h;
          }
          heap.push(priority, v);
        }
      }
    }

    this._explored = order.length;
    this._relaxations = 0;
    this._order = order;
    this._rebuild(source, target, prev, prevEdge);
  };

  /* Bellman–Ford ------------------------------------------------------ */

  RoadGraph.prototype._bellmanFord = function (source, target, mode, blocked) {
    var n = this.n;
    var dist = new Float64Array(n).fill(Infinity);
    var prev = new Int32Array(n).fill(-1);
    var prevEdge = new Int32Array(n).fill(-1);
    var relaxations = 0;

    dist[source] = 0;

    for (var pass = 0; pass < n - 1; pass++) {
      var changed = false;
      for (var u = 0; u < n; u++) {
        var du = dist[u];
        if (du === Infinity) continue;
        var start = this.outStart[u];
        var end = this.outStart[u + 1];
        for (var k = start; k < end; k++) {
          var e = this.outEdges[k];
          if (blocked && blocked.size > 0 && blocked.has(e)) continue;
          var v = this.eTo[e];
          var nd = du + this.weight(mode, e);
          if (nd + EPS < dist[v]) {
            dist[v] = nd;
            prev[v] = u;
            prevEdge[v] = e;
            changed = true;
            relaxations += 1;
          }
        }
      }
      if (!changed) break;
    }

    var order = [];
    for (var node = 0; node < n; node++) {
      if (dist[node] !== Infinity) order.push(node);
    }

    this._explored = order.length;
    this._relaxations = relaxations;
    this._order = order;
    this._rebuild(source, target, prev, prevEdge);
  };

  /* Bidirectional Dijkstra -------------------------------------------- */

  RoadGraph.prototype._bidirectional = function (source, target, mode, blocked) {
    if (source === target) {
      this._explored = 1;
      this._relaxations = 0;
      this._order = [source];
      this._rebuild(source, target, new Int32Array(this.n).fill(-1),
        new Int32Array(this.n).fill(-1));
      return;
    }

    var n = this.n;
    var distF = new Float64Array(n).fill(Infinity);
    var distB = new Float64Array(n).fill(Infinity);
    var prevF = new Int32Array(n).fill(-1);
    var prevB = new Int32Array(n).fill(-1);
    var prevEdgeF = new Int32Array(n).fill(-1);
    var prevEdgeB = new Int32Array(n).fill(-1);
    var settledF = new Uint8Array(n);
    var settledB = new Uint8Array(n);
    var heapF = new MinHeap();
    var heapB = new MinHeap();
    var order = [];
    var best = Infinity;
    var meet = -1;
    var graph = this;

    distF[source] = 0;
    distB[target] = 0;
    heapF.push(0, source);
    heapB.push(0, target);

    function expand(forward) {
      var heap = forward ? heapF : heapB;
      var dist = forward ? distF : distB;
      var otherDist = forward ? distB : distF;
      var settled = forward ? settledF : settledB;
      var prev = forward ? prevF : prevB;
      var prevEdge = forward ? prevEdgeF : prevEdgeB;
      var popped;
      var u;
      do {
        popped = heap.pop();
        u = popped[1];
      } while (settled[u] && heap.size() > 0);

      settled[u] = 1;
      order.push(u);

      if (otherDist[u] !== Infinity) {
        var candidate = dist[u] + otherDist[u];
        if (candidate < best) {
          best = candidate;
          meet = u;
        }
      }

      var start = forward ? graph.outStart[u] : graph.inStart[u];
      var end = forward ? graph.outStart[u + 1] : graph.inStart[u + 1];
      var list = forward ? graph.outEdges : graph.inEdges;
      for (var k = start; k < end; k++) {
        var e = list[k];
        if (blocked && blocked.size > 0 && blocked.has(e)) continue;
        var v = forward ? graph.eTo[e] : graph.eFrom[e];
        var nd = dist[u] + graph.weight(mode, e);
        if (nd + EPS < dist[v]) {
          dist[v] = nd;
          prev[v] = u;
          prevEdge[v] = e;
          heap.push(nd, v);
        }
      }
    }

    while (heapF.size() > 0 && heapB.size() > 0) {
      if (heapF.peekKey() + heapB.peekKey() >= best) break;
      if (heapF.peekKey() <= heapB.peekKey()) expand(true);
      else expand(false);
    }

    this._explored = order.length;
    this._relaxations = 0;
    this._order = order;

    if (meet === -1) {
      this._targetFound = false;
      this._path = [];
      this._edges = [];
      return;
    }

    var path = [];
    var edges = [];
    var node = meet;
    while (node !== -1) {
      path.push(node);
      if (node !== source) edges.push(prevEdgeF[node]);
      node = prevF[node];
    }
    path.reverse();
    edges.reverse();

    node = meet;
    while (node !== target) {
      var next = prevB[node];
      if (next === -1) break;
      path.push(next);
      edges.push(prevEdgeB[node]);
      node = next;
    }

    var reachesTarget = path[0] === source && path[path.length - 1] === target;
    this._targetFound = reachesTarget;
    this._path = reachesTarget ? path : [];
    this._edges = reachesTarget ? edges : [];
  };

  /* Public entry point ------------------------------------------------ */

  RoadGraph.prototype.route = function (algorithm, source, target, mode, blocked) {
    var started = performance.now();
    this._targetFound = false;
    this._path = [];
    this._edges = [];
    this._explored = 0;
    this._relaxations = 0;
    this._order = [];

    if (source == null || target == null) {
      return this._result(algorithm, source, target, mode, blocked, started);
    }

    switch (algorithm) {
      case 'astar':
        this._dijkstra('astar', source, target, mode, blocked, true);
        break;
      case 'bellman':
        this._bellmanFord(source, target, mode, blocked);
        break;
      case 'bidir':
        this._bidirectional(source, target, mode, blocked);
        break;
      case 'dijkstra':
      default:
        this._dijkstra('dijkstra', source, target, mode, blocked, false);
        break;
    }

    return this._result(algorithm, source, target, mode, blocked, started);
  };

  global.RastaGraph = {
    RoadGraph: RoadGraph,
    haversine: haversine,
    MinHeap: MinHeap
  };
})(window);
