(function (global) {
  'use strict';

  /* Canvas overlay that draws the nodes an algorithm settled, with an
     optional progressive reveal so the search can be watched. */
  var ExploreLayer = L.Layer.extend({
    initialize: function (nodes) {
      this._nodes = nodes;
      this._order = [];
      this._count = 0;
      this._color = '#38e0b0';
      this._raf = 0;
    },

    onAdd: function (map) {
      this._map = map;
      var canvas = this._canvas = L.DomUtil.create(
        'canvas', 'leaflet-zoom-animated leaflet-zoom-hide explore-canvas');
      canvas.style.pointerEvents = 'none';
      map.getPanes().overlayPane.appendChild(canvas);
      map.on('moveend zoomend viewreset resize', this._reset, this);
      this._reset();
    },

    onRemove: function (map) {
      map.off('moveend zoomend viewreset resize', this._reset, this);
      if (this._canvas && this._canvas.parentNode) {
        this._canvas.parentNode.removeChild(this._canvas);
      }
      this._map = null;
      if (this._raf) cancelAnimationFrame(this._raf);
    },

    setData: function (order, color, animate, onDone) {
      if (this._raf) {
        cancelAnimationFrame(this._raf);
        this._raf = 0;
      }
      this._order = order || [];
      this._color = color || '#38e0b0';
      this._onDone = onDone || null;
      this._count = animate ? 0 : this._order.length;
      this._reset();
      if (animate && this._order.length) {
        this._animate();
      } else if (this._onDone) {
        this._onDone();
        this._onDone = null;
      }
    },

    clear: function () {
      if (this._raf) {
        cancelAnimationFrame(this._raf);
        this._raf = 0;
      }
      this._order = [];
      this._count = 0;
      this._reset();
    },

    _animate: function () {
      var self = this;
      var total = this._order.length;
      var started = performance.now();
      var duration = Math.min(1200, Math.max(420, total * 0.7));

      function step(now) {
        var progress = Math.min(1, (now - started) / duration);
        var next = Math.round(total * progress);
        if (next > self._count) {
          var from = self._count;
          self._count = next;
          if (self._ctx) self._paint(from, self._count, false);
        }
        if (progress < 1) {
          self._raf = requestAnimationFrame(step);
        } else {
          self._raf = 0;
          self._count = total;
          self._paint(0, total, true);
          if (self._onDone) {
            self._onDone();
            self._onDone = null;
          }
        }
      }

      this._raf = requestAnimationFrame(step);
    },

    _reset: function () {
      var map = this._map;
      if (!map || !this._canvas) return;
      var size = map.getSize();
      var topLeft = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, topLeft);
      var dpr = window.devicePixelRatio || 1;
      this._canvas.width = Math.max(1, Math.round(size.x * dpr));
      this._canvas.height = Math.max(1, Math.round(size.y * dpr));
      this._canvas.style.width = size.x + 'px';
      this._canvas.style.height = size.y + 'px';
      var ctx = this._canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._ctx = ctx;
      this._paint(0, this._count, true);
    },

    _paint: function (from, to, clear) {
      var ctx = this._ctx;
      if (!ctx || !this._map) return;
      var size = this._map.getSize();
      if (clear) ctx.clearRect(0, 0, size.x, size.y);
      ctx.globalAlpha = 0.42;
      ctx.fillStyle = this._color;
      var nodes = this._nodes;
      var order = this._order;
      for (var i = from; i < to; i++) {
        var node = nodes[order[i]];
        if (!node) continue;
        var point = this._map.latLngToContainerPoint(node);
        ctx.fillRect(point.x - 1.2, point.y - 1.2, 2.4, 2.4);
      }
      ctx.globalAlpha = 1;
    }
  });

  global.ExploreLayer = ExploreLayer;
})(window);
