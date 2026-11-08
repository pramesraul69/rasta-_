(function () {
  'use strict';

  var ALGORITHMS = {
    dijkstra: { label: 'Dijkstra', color: '#5aa9ff', complexity: 'O((V + E) log V)' },
    astar: { label: 'A* search', color: '#38e0b0', complexity: 'O(E log V) worst case' },
    bellman: { label: 'Bellman–Ford', color: '#ffb454', complexity: 'O(V · E)' },
    bidir: { label: 'Bidirectional Dijkstra', color: '#c792ea', complexity: 'O((V + E) log V)' }
  };
  var ALGO_ORDER = ['dijkstra', 'astar', 'bellman', 'bidir'];

  var state = {
    algorithm: 'dijkstra',
    mode: 'distance',
    start: null,
    end: null,
    result: null,
    blocked: new Set(),
    blockedShown: new Set(),
    animate: true,
    showAllRoads: false,
    busy: false,
    offlineNotice: false
  };

  /* Short "ting" sound synthesised with the Web Audio API — no file needed. */
  var audioCtx = null;
  var hasPendingTing = false;

  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().then(function () {
          if (hasPendingTing) {
            hasPendingTing = false;
            triggerSound();
          }
        }).catch(function () {});
      } else if (hasPendingTing) {
        hasPendingTing = false;
        triggerSound();
      }
    } catch (e) {}
  }
  ['click', 'pointerdown', 'keydown', 'touchstart', 'mousemove'].forEach(function (event) {
    window.addEventListener(event, unlockAudio, { passive: true });
  });

  function playTing() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') {
        hasPendingTing = true;
        audioCtx.resume().then(function () {
          if (hasPendingTing) {
            hasPendingTing = false;
            triggerSound();
          }
        }).catch(function () {});
      } else {
        triggerSound();
      }
    } catch (e) { /* audio not available — fail silently */ }
  }

  function triggerSound() {
    try {
      var now = audioCtx.currentTime;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1800, now);
      osc.frequency.exponentialRampToValueAtTime(1200, now + 0.12);
      gain.gain.setValueAtTime(0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.28);
    } catch (e) {}
  }

  var graph = null;
  var map = null;
  var tileLayer = null;
  var networkLayer = null;
  var minorPolyline = null;
  var exploreLayer = null;
  var routeLayer = null;
  var snapLayer = null;
  var blockedLayer = null;
  var markerLayer = null;
  var renderer = null;
  var routeRenderer = null;
  var els = {};
  var toastTimer = 0;

  function $(id) { return document.getElementById(id); }

  /* ---------------------------------------------------------------- boot */

  function init() {
    els = {
      map: $('map'),
      graphStats: $('graphStats'),
      mapBadge: $('mapBadge'),
      mapNote: $('mapNote'),
      fromInput: $('fromInput'),
      toInput: $('toInput'),
      placeList: $('placeList'),
      swapBtn: $('swapBtn'),
      resetBtn: $('resetBtn'),
      compareBtn: $('compareBtn'),
      comparePanel: $('comparePanel'),
      compareBody: $('compareBody'),
      compareSub: $('compareSub'),
      compareClose: $('compareClose'),
      emptyState: $('emptyState'),
      resultBody: $('resultBody'),
      resultAlgo: $('resultAlgo'),
      distanceValue: $('distanceValue'),
      timeValue: $('timeValue'),
      exploredValue: $('exploredValue'),
      runtimeValue: $('runtimeValue'),
      complexityValue: $('complexityValue'),
      viaLine: $('viaLine'),
      journeyLine: $('journeyLine'),
      noRoute: $('noRoute'),
      snapNote: $('snapNote'),
      clearBlocksBtn: $('clearBlocksBtn'),
      animateToggle: $('animateToggle'),
      minorToggle: $('minorToggle'),
      resultsCard: $('resultsCard'),
      busy: $('busy'),
      busyText: $('busyText'),
      toast: $('toast')
    };
    els.algoButtons = Array.prototype.slice.call(document.querySelectorAll('[data-algo]'));
    els.modeButtons = Array.prototype.slice.call(document.querySelectorAll('[data-mode]'));

    document.documentElement.style.setProperty('--algo', ALGORITHMS.dijkstra.color);
    bindUi();
    loadGraph();
  }

  function bindUi() {
    els.algoButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        setAlgorithm(button.getAttribute('data-algo'));
      });
    });
    els.modeButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        setMode(button.getAttribute('data-mode'));
      });
    });
    els.fromInput.addEventListener('change', function () {
      handlePlaceInput('start', els.fromInput);
    });
    els.toInput.addEventListener('change', function () {
      handlePlaceInput('end', els.toInput);
    });
    [els.fromInput, els.toInput].forEach(function (input) {
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          handlePlaceInput(input === els.fromInput ? 'start' : 'end', input);
        }
      });
    });
    els.swapBtn.addEventListener('click', swapEndpoints);
    els.resetBtn.addEventListener('click', resetAll);
    els.compareBtn.addEventListener('click', compareAll);
    els.compareClose.addEventListener('click', closeComparison);
    els.clearBlocksBtn.addEventListener('click', clearBlocks);
    els.animateToggle.addEventListener('change', function () {
      state.animate = els.animateToggle.checked;
      if (state.result) {
        if (state.animate) {
          routeLayer.clearLayers();
          var result = state.result;
          exploreLayer.setData(result.order, ALGORITHMS[state.algorithm].color, true, function () {
            drawRoute(result);
          });
        } else {
          exploreLayer.setData(state.result.order, ALGORITHMS[state.algorithm].color, false);
          drawRoute(state.result);
        }
      }
    });
    els.minorToggle.addEventListener('change', function () {
      state.showAllRoads = els.minorToggle.checked;
      if (!minorPolyline) return;
      if (state.showAllRoads) networkLayer.addLayer(minorPolyline);
      else networkLayer.removeLayer(minorPolyline);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeComparison();
    });
  }

  function loadGraph() {
    setBusy(true, 'Loading the road network…');
    fetch('data/graph.json')
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (raw) {
        graph = new RastaGraph.RoadGraph(raw);
        setBusy(false);
        setupMap();
        updateMeta();
        populatePlaces();
        seedDemo();
      })
      .catch(function (error) {
        setBusy(false);
        showFatal(error);
      });
  }

  function showFatal(error) {
    els.graphStats.textContent = 'Graph unavailable';
    els.mapBadge.textContent = 'Data not loaded';
    els.map.innerHTML =
      '<div class="fatal">' +
      '<h2>Road data could not load</h2>' +
      '<p>The graph is loaded with <code>fetch()</code>, so this folder has to be ' +
      'served over HTTP. From the project folder run:</p>' +
      '<code>python3 -m http.server 8000</code>' +
      '<p>then open <b>http://localhost:8000</b>. ' +
      '(' + (error && error.message ? error.message : 'unknown error') + ')</p>' +
      '</div>';
  }

  function updateMeta() {
    var meta = graph.meta || {};
    els.graphStats.textContent =
      graph.n.toLocaleString() + ' nodes · ' + graph.m.toLocaleString() + ' edges';
    els.mapBadge.textContent =
      (meta.name || 'Kolkata') + ' · ' + graph.n.toLocaleString() + ' nodes' +
      (meta.generated ? ' · data ' + meta.generated : '');
  }

  /* ---------------------------------------------------------------- map */

  function setupMap() {
    var bbox = graph.meta.bbox;
    map = L.map('map', {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true
    });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: [24, 24] });
    map.setMinZoom(11);
    map.setMaxZoom(19);

    tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">' +
        'OpenStreetMap</a> contributors'
    }).addTo(map);

    var tileErrors = 0;
    tileLayer.on('tileerror', function () {
      tileErrors += 1;
      if (tileErrors >= 6 && !state.offlineNotice) {
        state.offlineNotice = true;
        els.map.classList.add('offline');
        els.mapNote.hidden = false;
        els.mapNote.textContent =
          'Map tiles unavailable — running on the local road network.';
      }
    });

    renderer = L.canvas({ padding: 0.5 });

    networkLayer = L.layerGroup().addTo(map);
    drawNetwork();

    exploreLayer = new ExploreLayer(graph.nodes);
    map.addLayer(exploreLayer);

    // Custom pane for route/snap/blocked lines so they render above the
    // exploration canvas (which sits in the default overlayPane at z-index 400).
    map.createPane('routePane').style.zIndex = 450;

    // SVG for route/snap/blocked lines: crisp at every zoom and directly
    // clickable, which is what powers "click the route to block it".
    routeRenderer = L.svg({ padding: 0.5, pane: 'routePane' });

    snapLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    blockedLayer = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);

    map.on('click', onMapClick);

    window.addEventListener('resize', function () {
      if (map) map.invalidateSize();
    });
  }

  function drawNetwork() {
    var major = [];
    var medium = [];
    var minor = [];
    var seen = new Set();

    for (var e = 0; e < graph.m; e++) {
      var u = graph.eFrom[e];
      var v = graph.eTo[e];
      var roadIndex = graph.eRoad[e];
      var low = Math.min(u, v);
      var high = Math.max(u, v);
      var key = low + ':' + high + ':' + roadIndex;
      if (seen.has(key)) continue;
      seen.add(key);
      var road = graph.roads[roadIndex] || ['', 'road'];
      var type = road[1];
      var shape = [graph.nodes[u], graph.nodes[v]];
      if (type.indexOf('motorway') === 0 || type.indexOf('trunk') === 0 ||
        type.indexOf('primary') === 0) {
        major.push(shape);
      } else if (type.indexOf('secondary') === 0 || type.indexOf('tertiary') === 0) {
        medium.push(shape);
      } else {
        minor.push(shape);
      }
    }

    L.polyline(major, {
      color: '#7d97b3', weight: 1.8, opacity: 0.28,
      interactive: false, renderer: renderer
    }).addTo(networkLayer);
    L.polyline(medium, {
      color: '#6d8aa8', weight: 1.1, opacity: 0.16,
      interactive: false, renderer: renderer
    }).addTo(networkLayer);
    minorPolyline = L.polyline(minor, {
      color: '#51697f', weight: 1, opacity: 0.2,
      interactive: false, renderer: renderer
    });
    if (state.showAllRoads) networkLayer.addLayer(minorPolyline);
  }

  function onMapClick(event) {
    if (!graph || state.busy) return;
    if (!state.start || (state.start && state.end)) {
      clearEndpoint('end');
      clearRouteVisuals();
      setEndpoint('start', event.latlng, {});
    } else {
      setEndpoint('end', event.latlng, {});
    }
    if (state.start && state.end) runCurrent();
    else updateEmptyState();
  }

  /* ---------------------------------------------------------------- endpoints */

  function endpointIcon(kind) {
    return L.divIcon({
      className: 'endpoint-marker ' + kind,
      html: '<span>' + (kind === 'start' ? 'A' : 'B') + '</span>',
      iconSize: [30, 38],
      iconAnchor: [15, 38]
    });
  }

  function coordinateText(latlng) {
    return latlng.lat.toFixed(5) + ', ' + latlng.lng.toFixed(5);
  }

  function setEndpoint(kind, latlng, options) {
    options = options || {};
    if (!graph) return;
    var snap;
    if (options.node != null && graph.routable && graph.routable[options.node]) {
      snap = { node: options.node, metres: 0 };
    } else {
      snap = graph.nearestNode(latlng.lat, latlng.lng);
    }
    if (!snap || snap.node == null) return;

    var existing = state[kind];
    if (existing && existing.marker) markerLayer.removeLayer(existing.marker);

    var marker = L.marker(latlng, {
      icon: endpointIcon(kind),
      draggable: true,
      autoPan: true,
      keyboard: false,
      zIndexOffset: kind === 'start' ? 600 : 500
    }).addTo(markerLayer);

    marker.on('dragend', function () {
      var pos = marker.getLatLng();
      var snapped = graph.nearestNode(pos.lat, pos.lng);
      var endpoint = state[kind];
      if (!endpoint || !snapped) return;
      endpoint.latlng = L.latLng(pos.lat, pos.lng);
      endpoint.node = snapped.node;
      endpoint.snapMetres = snapped.metres;
      endpoint.label = null;
      setInputText(kind, coordinateText(endpoint.latlng));
      refreshSnapNote();
      runCurrent();
    });

    state[kind] = {
      latlng: L.latLng(latlng.lat, latlng.lng),
      node: snap.node,
      snapMetres: snap.metres,
      label: options.label || null,
      marker: marker
    };

    setInputText(kind, options.label || coordinateText(state[kind].latlng));
    refreshSnapNote();
  }

  function setInputText(kind, text) {
    var input = kind === 'start' ? els.fromInput : els.toInput;
    input.value = text;
  }

  function clearEndpoint(kind) {
    var endpoint = state[kind];
    if (endpoint && endpoint.marker) markerLayer.removeLayer(endpoint.marker);
    state[kind] = null;
    setInputText(kind, '');
    refreshSnapNote();
  }

  function refreshSnapNote() {
    var parts = [];
    if (state.start) parts.push('A ' + formatMetres(state.start.snapMetres));
    if (state.end) parts.push('B ' + formatMetres(state.end.snapMetres));
    els.snapNote.textContent = parts.length
      ? 'Snapped to the road: ' + parts.join(' · ') + '. Drag a pin to adjust.'
      : 'Click once for A, again for B. Drag pins to fine-tune.';
  }

  function endpointLabel(endpoint) {
    if (!endpoint) return '—';
    return endpoint.label || coordinateText(endpoint.latlng);
  }

  /* ---------------------------------------------------------------- search */

  function populatePlaces() {
    var fragment = document.createDocumentFragment();
    graph.places.forEach(function (place) {
      var option = document.createElement('option');
      option.value = place[0];
      fragment.appendChild(option);
    });
    els.placeList.appendChild(fragment);
  }

  function lookupPlace(query) {
    var q = query.trim().toLowerCase();
    if (!q || !graph) return null;
    var places = graph.places;
    var i;
    for (i = 0; i < places.length; i++) {
      if (places[i][0].toLowerCase() === q) return places[i];
    }
    for (i = 0; i < places.length; i++) {
      if (places[i][0].toLowerCase().indexOf(q) !== -1) return places[i];
    }
    return null;
  }

  function handlePlaceInput(kind, input) {
    if (!graph) return;
    var value = input.value.trim();
    if (!value) {
      clearEndpoint(kind);
      clearRouteVisuals();
      updateEmptyState();
      return;
    }
    var place = lookupPlace(value);
    if (!place) {
      toast('No offline match for “' + value + '”. Click the map instead.');
      return;
    }
    setEndpoint(kind, L.latLng(place[2], place[3]), {
      node: place[4],
      label: place[0]
    });
    if (state.start && state.end) runCurrent();
    else updateEmptyState();
  }

  /* ---------------------------------------------------------------- controls */

  function setAlgorithm(id) {
    if (!ALGORITHMS[id]) return;
    state.algorithm = id;
    els.algoButtons.forEach(function (button) {
      var active = button.getAttribute('data-algo') === id;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    var color = ALGORITHMS[id].color;
    document.documentElement.style.setProperty('--algo', color);
    if (state.start && state.end) runCurrent();
    updateCompareActive();
  }

  function setMode(mode) {
    state.mode = mode === 'time' ? 'time' : 'distance';
    els.modeButtons.forEach(function (button) {
      var active = button.getAttribute('data-mode') === state.mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    closeComparison();
    if (state.start && state.end) runCurrent();
  }

  function swapEndpoints() {
    if (!state.start || !state.end) {
      toast('Set a start and a destination first.');
      return;
    }
    var start = state.start;
    var end = state.end;
    markerLayer.clearLayers();
    state.start = null;
    state.end = null;
    setEndpoint('start', end.latlng, { node: end.node, label: end.label });
    setEndpoint('end', start.latlng, { node: start.node, label: start.label });
    runCurrent();
  }

  function resetAll() {
    markerLayer.clearLayers();
    state.start = null;
    state.end = null;
    state.result = null;
    setInputText('start', '');
    setInputText('end', '');
    clearRouteVisuals();
    updateEmptyState();
    refreshSnapNote();
  }

  /* ---------------------------------------------------------------- routing */

  function runCurrent(options) {
    options = options || {};
    if (!graph || !state.start || !state.end) {
      updateEmptyState();
      return;
    }

    /* Guard: if both clicks snapped to the exact same graph node, warn the user
       rather than silently producing a zero-length "route". */
    if (state.start.node === state.end.node && !options._isDemo) {
      toast('Start and destination snapped to the same road node — try clicking farther apart.');
    }

    var result = graph.route(
      state.algorithm,
      state.start.node,
      state.end.node,
      state.mode,
      state.blocked
    );

    state.result = result;
    renderResult(result);
    drawSnapLines();

    if (state.animate) {
      // Clear previous route so the exploration animation plays on a clean map,
      // then draw the shortest path only after the animation finishes.
      routeLayer.clearLayers();
      exploreLayer.setData(result.order, ALGORITHMS[state.algorithm].color, true, function () {
        drawRoute(result);
        if (result.found) playTing();
      });
    } else {
      drawRoute(result);
      exploreLayer.setData(result.order, ALGORITHMS[state.algorithm].color, false);
      if (result.found) playTing();
    }

    if (options.fit && result.found && result.path.length > 1) {
      var points = result.path.map(function (index) { return graph.nodes[index]; });
      map.fitBounds(L.latLngBounds(points), {
        padding: [70, 70],
        maxZoom: 15,
        animate: false
      });
    }
  }

  function renderResult(result) {
    var algorithm = ALGORITHMS[state.algorithm];
    els.emptyState.hidden = true;
    els.resultBody.hidden = false;
    els.resultAlgo.textContent = algorithm.label;
    els.resultAlgo.style.setProperty('--c', algorithm.color);
    els.distanceValue.textContent = result.found ? formatDistance(result.distance) : '—';
    els.timeValue.textContent = result.found ? formatDuration(result.duration) : '—';
    els.exploredValue.textContent = result.explored.toLocaleString();
    els.runtimeValue.textContent = formatMs(result.runtimeMs);
    els.complexityValue.textContent = algorithm.complexity;
    els.noRoute.hidden = result.found;
    els.journeyLine.textContent =
      'A · ' + endpointLabel(state.start) + '  →  B · ' + endpointLabel(state.end) +
      '  ·  ' + (state.mode === 'time' ? 'fastest travel time' : 'shortest distance');

    var names = [];
    if (result.found) {
      for (var i = 0; i < result.edges.length; i++) {
        var name = roadName(result.edges[i]);
        if (name !== names[names.length - 1]) names.push(name);
      }
    }
    if (names.length) {
      els.viaLine.hidden = false;
      els.viaLine.textContent = 'via ' + names.slice(0, 6).join(' · ') +
        (names.length > 6 ? ' …' : '');
    } else {
      els.viaLine.hidden = true;
      els.viaLine.textContent = '';
    }
  }

  function updateEmptyState() {
    els.resultBody.hidden = true;
    els.emptyState.hidden = false;
    els.resultAlgo.textContent = ALGORITHMS[state.algorithm].label;
    els.resultAlgo.style.setProperty('--c', ALGORITHMS[state.algorithm].color);
    els.emptyState.textContent = state.start
      ? 'Start set. Now click the destination on the map.'
      : 'Pick a start and a destination to run the search.';
  }

  function drawRoute(result) {
    routeLayer.clearLayers();
    snapLayer.clearLayers();
    if (!result || !result.found || result.path.length < 2) return;

    var points = result.path.map(function (index) { return graph.nodes[index]; });
    var color = ALGORITHMS[result.algorithm].color;

    L.polyline(points, {
      color: color,
      weight: 14,
      opacity: 0.16,
      interactive: false,
      renderer: routeRenderer,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(routeLayer);

    L.polyline(points, {
      color: '#04121c',
      weight: 10,
      opacity: 0.7,
      interactive: false,
      renderer: routeRenderer,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(routeLayer);

    var line = L.polyline(points, {
      color: color,
      weight: 5,
      opacity: 0.95,
      interactive: true,
      bubblingMouseEvents: false,
      renderer: routeRenderer,
      className: 'route-hit',
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(routeLayer);

    line.on('click', function (event) {
      blockAt(event.latlng, result);
    });
  }

  function drawSnapLines() {
    snapLayer.clearLayers();
    [['start', '#38e0b0'], ['end', '#ffb454']].forEach(function (pair) {
      var endpoint = state[pair[0]];
      if (!endpoint) return;
      var snapped = graph.nodes[endpoint.node];
      if (!snapped) return;
      var metres = RastaGraph.haversine(
        endpoint.latlng.lat, endpoint.latlng.lng, snapped[0], snapped[1]);
      if (metres < 2) return;
      L.polyline([endpoint.latlng, snapped], {
        color: pair[1],
        weight: 2,
        opacity: 0.65,
        dashArray: '4 6',
        interactive: false,
        renderer: routeRenderer
      }).addTo(snapLayer);
    });
  }

  function roadName(edge) {
    var road = graph.roads[graph.eRoad[edge]];
    return road ? road[0] : 'Unnamed road';
  }

  /* ---------------------------------------------------------------- road blocks */

  function blockAt(latlng, result) {
    if (!result || !result.found || !result.edges.length) return;
    var clickPoint = map.latLngToContainerPoint(latlng);
    var bestEdge = -1;
    var bestDistance = Infinity;

    result.edges.forEach(function (edge) {
      var a = map.latLngToContainerPoint(graph.nodes[graph.eFrom[edge]]);
      var b = map.latLngToContainerPoint(graph.nodes[graph.eTo[edge]]);
      var distance = pointSegmentDistance(clickPoint, a, b);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestEdge = edge;
      }
    });

    if (bestEdge < 0 || bestDistance > 12) {
      toast('Click directly on the highlighted route to block a segment.');
      return;
    }

    var edges = [bestEdge];
    if (graph.reverse[bestEdge] >= 0) edges.push(graph.reverse[bestEdge]);

    var added = false;
    edges.forEach(function (edge) {
      if (!state.blocked.has(edge)) {
        state.blocked.add(edge);
        added = true;
      }
    });
    if (!added) return;

    drawBlockedSegment(bestEdge);
    updateBlockUi();
    toast('Blocked ' + roadName(bestEdge) + ' — rerouting.');
    runCurrent();
  }

  function drawBlockedSegment(edge) {
    var u = graph.eFrom[edge];
    var v = graph.eTo[edge];
    var road = graph.eRoad[edge];
    var key = Math.min(u, v) + ':' + Math.max(u, v) + ':' + road;
    if (state.blockedShown.has(key)) return;
    state.blockedShown.add(key);

    L.polyline([graph.nodes[u], graph.nodes[v]], {
      color: '#ff5d73',
      weight: 6,
      opacity: 0.92,
      dashArray: '3 9',
      lineCap: 'round',
      interactive: false,
      renderer: routeRenderer
    }).addTo(blockedLayer);
  }

  function updateBlockUi() {
    var count = state.blockedShown.size;
    els.clearBlocksBtn.disabled = count === 0;
    els.clearBlocksBtn.textContent = count
      ? 'Clear ' + count + ' block' + (count === 1 ? '' : 's')
      : 'Clear blocks';
  }

  function clearBlocks() {
    state.blocked.clear();
    state.blockedShown.clear();
    blockedLayer.clearLayers();
    updateBlockUi();
    if (state.start && state.end) runCurrent();
    toast('Road blocks cleared.');
  }

  function pointSegmentDistance(point, a, b) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var lengthSquared = dx * dx + dy * dy;
    var t = lengthSquared
      ? ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared
      : 0;
    t = Math.max(0, Math.min(1, t));
    var px = a.x + t * dx;
    var py = a.y + t * dy;
    return Math.hypot(point.x - px, point.y - py);
  }

  /* ---------------------------------------------------------------- comparison */

  function compareAll() {
    if (!graph) return;
    if (!state.start || !state.end) {
      toast('Set a start and a destination first.');
      return;
    }
    if (state.busy) return;

    setBusy(true, 'Running all four algorithms…');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var rows;
        try {
          rows = ALGO_ORDER.map(function (id) {
            return graph.route(id, state.start.node, state.end.node,
              state.mode, state.blocked);
          });
        } catch (error) {
          setBusy(false);
          toast('Comparison failed: ' + error.message);
          return;
        }
        setBusy(false);
        showComparison(rows);
      });
    });
  }

  function showComparison(rows) {
    els.comparePanel.hidden = false;
    els.compareBody.innerHTML = '';

    var fastest = Infinity;
    rows.forEach(function (row) {
      if (row.found) fastest = Math.min(fastest, row.runtimeMs);
    });

    rows.forEach(function (row) {
      var algorithm = ALGORITHMS[row.algorithm];
      var tr = document.createElement('tr');
      tr.setAttribute('data-algo', row.algorithm);
      if (row.algorithm === state.algorithm) tr.classList.add('is-active');

      var nameCell = document.createElement('td');
      var nameWrap = document.createElement('span');
      nameWrap.className = 'algo-name';
      nameWrap.style.setProperty('--c', algorithm.color);
      var dot = document.createElement('i');
      dot.className = 'dot';
      nameWrap.appendChild(dot);
      nameWrap.appendChild(document.createTextNode(algorithm.label));
      nameCell.appendChild(nameWrap);

      var distanceCell = document.createElement('td');
      distanceCell.className = 'mono';
      distanceCell.textContent = row.found ? formatDistance(row.distance) : '—';

      var timeCell = document.createElement('td');
      timeCell.className = 'mono';
      timeCell.textContent = row.found ? formatDuration(row.duration) : '—';

      var exploredCell = document.createElement('td');
      exploredCell.className = 'mono';
      exploredCell.textContent = row.explored.toLocaleString();

      var runtimeCell = document.createElement('td');
      runtimeCell.className = 'mono';
      runtimeCell.textContent = formatMs(row.runtimeMs);
      if (row.found && row.runtimeMs === fastest) {
        var badge = document.createElement('span');
        badge.className = 'fastest';
        badge.textContent = 'fastest';
        runtimeCell.appendChild(badge);
      }

      var complexityCell = document.createElement('td');
      complexityCell.className = 'mono small';
      complexityCell.textContent = algorithm.complexity;

      tr.appendChild(nameCell);
      tr.appendChild(distanceCell);
      tr.appendChild(timeCell);
      tr.appendChild(exploredCell);
      tr.appendChild(runtimeCell);
      tr.appendChild(complexityCell);

      tr.addEventListener('click', function () {
        setAlgorithm(row.algorithm);
        if (window.innerWidth <= 900) closeComparison();
      });

      els.compareBody.appendChild(tr);
    });

    var modeLabel = state.mode === 'time' ? 'fastest travel time' : 'shortest distance';
    els.compareSub.textContent =
      endpointLabel(state.start) + ' → ' + endpointLabel(state.end) + ' · ' + modeLabel;
  }

  function updateCompareActive() {
    if (!els.compareBody) return;
    Array.prototype.forEach.call(
      els.compareBody.querySelectorAll('tr'),
      function (row) {
        row.classList.toggle('is-active',
          row.getAttribute('data-algo') === state.algorithm);
      }
    );
  }

  function closeComparison() {
    if (els.comparePanel) els.comparePanel.hidden = true;
  }

  /* ---------------------------------------------------------------- formatting */

  function formatDistance(metres) {
    if (!isFinite(metres)) return '—';
    if (metres < 950) return Math.round(metres) + ' m';
    return (metres / 1000).toFixed(2) + ' km';
  }

  function formatDuration(seconds) {
    if (!isFinite(seconds)) return '—';
    if (seconds < 60) return Math.max(1, Math.round(seconds)) + ' s';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + ' min';
    var hours = Math.floor(minutes / 60);
    var rest = minutes % 60;
    return hours + ' h ' + (rest < 10 ? '0' + rest : rest) + ' min';
  }

  function formatMetres(metres) {
    if (!isFinite(metres)) return '—';
    return Math.round(metres) + ' m';
  }

  function formatMs(ms) {
    if (!isFinite(ms)) return '—';
    if (ms < 1) return '<1 ms';
    if (ms < 1000) return Math.round(ms) + ' ms';
    return (ms / 1000).toFixed(2) + ' s';
  }

  /* ---------------------------------------------------------------- misc */

  function setBusy(flag, text) {
    state.busy = flag;
    els.busy.hidden = !flag;
    if (text) els.busyText.textContent = text;
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.hidden = true;
    }, 3400);
  }

  function seedDemo() {
    var startPlace = lookupPlace('Shyambazar');
    var endPlace = lookupPlace('Sealdah');
    var startLatLng;
    var endLatLng;
    var startNode = null;
    var endNode = null;

    if (startPlace) {
      startLatLng = L.latLng(startPlace[2], startPlace[3]);
      startNode = startPlace[4];
    } else {
      startLatLng = L.latLng(22.6007, 88.3694);
      startNode = graph.nearestNode(22.6007, 88.3694).node;
    }
    if (endPlace) {
      endLatLng = L.latLng(endPlace[2], endPlace[3]);
      endNode = endPlace[4];
    } else {
      endLatLng = L.latLng(22.5675, 88.3708);
      endNode = graph.nearestNode(22.5675, 88.3708).node;
    }

    setEndpoint('start', startLatLng, { node: startNode, label: startPlace ? startPlace[0] : null });
    setEndpoint('end', endLatLng, { node: endNode, label: endPlace ? endPlace[0] : null });
    runCurrent({ fit: true, _isDemo: true });
  }

  function clearRouteVisuals() {
    if (routeLayer) routeLayer.clearLayers();
    if (snapLayer) snapLayer.clearLayers();
    if (exploreLayer) exploreLayer.clear();
    state.result = null;
  }

  init();
})();
