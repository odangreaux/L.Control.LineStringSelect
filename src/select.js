"use strict";

var L = global.L || require('leaflet');
var geometry = require('./geometry');
var ControlMarker = require('./marker');
var Endpoint = require('./endpoint');
var Selection = require('./selection');
var rbush = global.rbush || require('rbush');

/**
 * LineString select control
 *
 * @class  L.Control.LineStringSelect
 * @extends {L.Control}
 */
var Select = L.Control.extend( /**  @lends Select.prototype */ {

  includes: L.Mixin.Events,

  /**
   * @type {Object}
   */
  options: {
    startMarkerClass: 'select-marker select-start-marker',
    endMarkerClass: 'select-marker select-end-marker',
    movingMarkerClass: 'select-marker select-moving-marker',
    name: 'leaflet-linestring-select',
    lineWeight: 4,
    lineTolerance: 5,

    // moving(sliding) marker
    movingMarkerStyle: {
      fillColor: '#fff',
      fillOpacity: 1,
      weight: 2,
      opacity: 0.5,
      color: '#000'
    },

    // endpoint
    endpointStyle: {
      radius: 5,
      color: '#111',
      fillColor: '#fff',
      fillOpacity: 1
    },

    selectionStyle: {
      color: '#0ff',
      opacity: 1
    },

    position: 'topright' // chose your own if you want
  },

  /**
   * @param  {Object} options
   * @constructor
   */
  initialize: function(options) {

    options = options || {};

    /**
     * @type {Endpoint}
     */
    this._startMarker = null;

    /**
     * @type {Endpoint}
     */
    this._endMarker = null;

    /**
     * @type {Marker}
     */
    this._movingMarker = null;

    /**
     * @type {Object}
     */
    this._feature = null;

    /**
     * @type {L.Polyline}
     */
    this._layer = null;

    /**
     * @type {Selection}
     */
    this._selection = null;

    /**
     * Mouse pointer tolerance
     * @type {L.LatLng}
     */
    this._tolerance = null;

    L.Util.setOptions(this, options);
    L.Control.prototype.initialize.call(this, this.options);
  },

  /**
   * @param {L.Map} map
   */
  onAdd: function(map) {
    var container = this._container = L.DomUtil.create('div',
      this.options.containerClass
    );
    L.DomEvent
      .disableClickPropagation(container)
      .disableScrollPropagation(container);

    return container;
  },

  /**
   * @param  {L.Map} map
   */
  onRemove: function(map) {},

  /**
   * Enable selection mode for line string
   * @param  {Object} options
   * @return {Select}
   */
  enable: function(options) {
    this._layer = options.layer;
    this._feature = options.feature || options.layer.toGeoJSON();

    this._createHandles();

    this._buildTree();

    this._layer.on('click', this._onLayerClick, this);

    this._map.on('moveend zoomend resize',
      this._calculatePointerTolerance, this);
    this._map.on('mousemove', this._onMousemove, this)
      .on('mousedown', this._onMouseDown, this)
      .on('click', this._onMapClick, this);

    this._calculatePointerTolerance();

    return this;
  },

  /**
   * Disable selection
   * @return {Select}
   */
  disable: function() {
    this.reset();

    this._map.removeLayer(this._movingMarker);
    this._movingMarker = null;

    this._layer.off('click', this._onLayerClick, this);

    this._map.off('moveend zoomend resize',
      this._calculatePointerTolerance, this);
    this._map.off('mousemove', this._onMousemove, this)
      .off('mousedown', this._onMouseDown, this)
      .off('click', this._onMapClick, this);

    this._feature = null;
    this._layer = null;

    return this;
  },

  /**
   * Reset selection
   * @return {Select}
   */
  reset: function() {
    if (this._startMarker) {
      this._map.removeLayer(this._startMarker);
      this._startMarker = null;
    }

    if (this._endMarker) {
      this._map.removeLayer(this._endMarker);
      this._endMarker = null;
    }

    if (this._selection) {
      this._map.removeLayer(this._selection);
      this._selection = null;
    }

    this._movingMarker.setLatLng(this._layer.getLatLngs()[0]).show();

    return this;
  },

  /**
   * Selection latlngs
   * @return {Array.<L.LatLng>}
   */
  getSelection: function() {
    if (this._selection) {
      return this._selection.getLatLngs();
    }
    return null;
  },

  /**
   * Selection geoJSON
   * @return {Object|Null}
   */
  toGeoJSON: function() {
    if (this._selection) {
      return this._selection.toGeoJSON();
    }
    return null;
  },

  /**
   * Select from one meter point to another
   * @param  {Number} startM
   * @param  {Number} endM
   * @return {Select}
   */
  selectMeters: function(startM, endM) {
    this.reset();

    if (startM < 0 || endM < 0) {
      throw new Error("Can't use negative meter values for distance selection");
    }

    var start = this._pointAtM(startM);
    var end = this._pointAtM(endM);

    start = this._getNearestPoint(start);
    end = this._getNearestPoint(end);

    this._setPoint(start, start.start, start.end);
    this._setPoint(end, end.start, end.end);
    return this;
  },

  /**
   * Calculate distance in meters from one point to another
   *
   * @param  {Array.<Number>} A
   * @param  {Array.<Number>} B
   * @return {Number}
   */
  _distance: function(A, B) {
    if (this.options.distance) {
      return this.options.distance(A, B);
    } else {
      return new L.LatLng(A[1], A[0]).distanceTo(new L.LatLng(B[1], B[0]));
    }
  },

  /**
   * Projected point from GeoJSON
   *
   * @param  {Array.<Number>} coord
   * @return {Array.<Number>}
   */
  _getProjectedPoint: function(coord) {
    if (this.options.getProjectedPoint) {
      return this.options.getProjectedPoint.call(this, coord);
    }
    coord = this._map.options.crs.latLngToPoint(new L.LatLng(coord[1], coord[0]), this._map.getMaxZoom());
    return [coord.x, coord.y];
  },

  /**
   * Point on segment, `m` meters from the start
   * @param  {Array.<Number>} start
   * @param  {Array.<Number>} end
   * @param  {Number}         m
   * @return {Array.<Number>}
   */
  _pointAtSegmentM: function(start, end, m) {
    start = this._getProjectedPoint(start);
    end = this._getProjectedPoint(end);

    var length = this._distance(start, end);
    var coords = geometry.pointOnSegment(start, end, m, length);
    return L.point(coords);
  },

  /**
   * Point at `m` mark on the linestring
   * @param  {Number} m
   * @return {L.LatLng}
   */
  _pointAtM: function(m) {
    var coords = this._feature.geometry.coordinates;
    var dist = 0;
    var point;

    for (var i = 1, len = coords.length; i < len; i++) {
      var segmentLength = this._distance(coords[i - 1], coords[i]);
      if (dist + segmentLength <= m) {
        dist += segmentLength;
      } else {
        break;
      }
    }

    if (dist === m || i === coords.length) {
      point = coords[i - 1];
      return new L.LatLng(point[1], point[0]);
    }

    point = this._pointAtSegmentM(coords[i - 1], coords[i], m - dist);
    return this._map.options.crs.pointToLatLng(point, this._map.getMaxZoom());
  },

  /**
   * Calculates buffer zone around pointer.
   * If map state changes it has to be recalculated in order
   * to maintain precision
   */
  _calculatePointerTolerance: function() {
    var center = this._map.getCenter();
    var shift = this.options.lineWeight * 0.5 + this.options.lineTolerance;
    var shifted = this._map.layerPointToLatLng(
      this._map.latLngToLayerPoint(center)
      .add(new L.Point(shift, shift)));

    this._tolerance = new L.LatLng(
      Math.abs(center.lat - shifted.lat),
      Math.abs(center.lng - shifted.lng)
    );
  },

  /**
   * Control handles
   */
  _createHandles: function() {
    var pos = L.latLng(this._layer._latlngs[0]);
    var style = this.options.movingMarkerStyle;

    style.radius = this.options.lineTolerance;
    style.className = this.options.movingMarkerClass;

    this._movingMarker = new ControlMarker(pos, style).addTo(this._map);
    this._movingMarker.on('click', this._onMovingMarkerClick, this);
  },

  /**
   * @param  {Object} evt
   */
  _onMovingMarkerClick: function(evt) {
    this._setPoint(this._movingMarker.getLatLng(),
      this._movingMarker.start,
      this._movingMarker.end);
  },

  /**
   * No moving marker on touch device
   * @param  {Object} evt
   */
  _onLayerClick: function(evt) {
    var coords = this._getNearestPoint(evt.latlng);
    if (coords) {
      this._setPoint(L.latLng(coords), coords.start, coords.end);
    } else {
      this._setPoint(evt.latlng);
    }
  },

  /**
   * Map clicked, if near the moving point - set endpoint
   * @param  {Object} evt
   */
  _onMapClick: function(evt) {
    if (!this._endMarker) {
      var pos = this._map.latLngToLayerPoint(evt.latlng);
      var coords = this._movingMarker.getLatLng();
      var mPos = this._map.latLngToLayerPoint(coords);
      var distance = Math.sqrt(Math.pow(pos.x - mPos.x, 2) +
        Math.pow(pos.y - mPos.y, 2));

      if (distance <= this.options.lineTolerance * 2) {
        coords = this._getNearestPoint(coords)
        this._setPoint(coords, coords.start, coords.end);
      }
    }
  },

  /**
   * @param {Object} evt
   */
  _setPoint: function(pos, start, end) {
    var style = this.options.endpointStyle;
    if (!this._startMarker) {
      style.className = this.options.startMarkerClass;

      this._startMarker = new Endpoint(pos, style).addTo(this._map);
      // this._startMarker.on('mouseover', this._movingMarker.hide, this._movingMarker)
      //   .on('mouseout', this._movingMarker.show, this._movingMarker);
      this._startMarker.start = start;
      this._startMarker.end = end;
      this.fire('select:start', {
        latlng: pos
      });
    } else if (!this._endMarker) {
      style.className = this.options.endMarkerClass;
      this._endMarker = new Endpoint(pos, style).addTo(this._map);
      // this._endMarker.on('mouseover', this._movingMarker.hide, this._movingMarker)
      //   .on('mouseout', this._movingMarker.show, this._movingMarker);

      this._endMarker.start = start;
      this._endMarker.end = end;

      //this._map.off('mousemove', this._onMousemove, this);
      this._movingMarker.hide();
      this.fire('select:end', {
        latlng: pos
      });
      this._onSelect();
    }
  },

  /**
   * Mouse pointer bounds
   * @param  {L.LatLng} latlng
   * @return {Array.<Array.<Number>>}
   */
  _getPointerBounds: function(latlng) {
    var tx = this._tolerance.lng,
      ty = this._tolerance.lat;

    return [
      [latlng.lat - ty, latlng.lng - tx],
      [latlng.lat + ty, latlng.lng + tx]
    ];
  },

  /**
   * Check if user tries to drag a handle
   * @param  {Object} evt
   */
  _onMouseDown: function(evt) {
    var target = (evt.originalEvent.target || evt.originalEvent.srcElement);
    if (this._startMarker && this._startMarker._path === target) {
      this._dragging = this._startMarker;
      this._static = this._endMarker;
    } else if (this._endMarker && this._endMarker._path === target) {
      this._dragging = this._endMarker;
      this._static = this._startMarker;
    }
    if (this._dragging) {
      L.DomEvent.stop(evt);
      this._dragging._dragging = true;
      this._map.dragging.disable();
      this._map.once('mouseup', this._stopHandlerDrag, this);
    }
  },

  /**
   * Clears drag handlers
   * @param  {Object} evt
   */
  _stopHandlerDrag: function(evt) {
    if (this._dragging) {
      global.clearTimeout(this._dragTimer);
      this._map.dragging.enable();
      this._dragging._dragging = null;
      this._dragging = null;
      this._onDragStopped(this._dragging, evt.latlng);
    }
  },

  /**
   * @param  {Endpoint} handle
   * @param  {L.LatLng} coords
   */
  _onDragStopped: function(handle, coords) {
    this._onSelect();
  },

  /**
   * Ensures that the startpoint would be before endpoint
   */
  _checkEndPoints: function() {
    if (this._startMarker.start > this._endMarker.start) {
      var swap = this._startMarker;
      this._startMarker = this._endMarker;
      this._endMarker = swap;
    }
  },

  /**
   * Selection event, show selected polyline
   */
  _onSelect: function() {
    this._checkEndPoints();

    var start = this._startMarker.end;
    var end = this._endMarker.start;
    var coords = this._layer._latlngs.slice(start, end + 1);

    coords.unshift(this._startMarker.getLatLng());
    coords.push(this._endMarker.getLatLng());

    if (!this._selection) {
      this._selection = new Selection(
        coords,
        this.options.selectionStyle,
        this._layer
      ).addTo(map);

      // markers should be above the selection
      this._startMarker.bringToFront();
      this._endMarker.bringToFront();
    } else {
      this._selection._latlngs = coords;
      this._selection.updatePathFromSource(
        this._startMarker.end,
        this._endMarker.start
      );
    }
    this.fire('selection');
  },

  /**
   * Mouse move: follow the path with the moving marker or drag
   *
   * @param  {Object} evt
   */
  _onMousemove: function(evt) {
    var coords = this._getNearestPoint(evt.latlng);
    if (this._dragging) {
      if (coords) {
        this._dragging.start = coords.start;
        this._dragging.end = coords.end;
        this._dragging.setLatLng(coords);
      }
      if (this._startMarker && this._endMarker) {
        this._onSelect();
      }
      global.clearTimeout(this._dragTimer);
      this._dragTimer = global.setTimeout(this._stopHandlerDrag.bind(this, evt), 750);
    } else {
      if (coords) {
        this._movingMarker.setLatLng(coords);
        this._movingMarker.start = coords.start;
        this._movingMarker.end = coords.end;
      }
    }
  },

  /**
   * Fin nearest point on the line string.
   * 1. search RTree of segments
   * 2. calculate nearest segment
   * 3. , then the point on it
   *
   * @param  {L.LatLng} latlng
   * @param  {L.LatLng} tolerance
   * @return {Array.<Number>}
   */
  _getNearestPoint: function(latlng, tolerance) {
    var coords = this._getPointerBounds(latlng, tolerance);
    var map = this._map;

    ////// visual debug
    // if (!this._m) {
    //   this._m = new L.Rectangle(coords, {
    //     weight: 2,
    //     fillOpacity: 0
    //   }).addTo(this._map);
    // } else {
    //   this._m.setBounds(coords);
    // }
    ////// visual debug

    var boxes = this._tree.search(
      this._toTreeNode(coords[0].reverse(), coords[1].reverse())
    );

    if (boxes.length !== 0) {
      var fcoords = this._feature.geometry.coordinates;
      var d = Number.MAX_VALUE;
      var pos = [latlng.lng, latlng.lat];
      var startIndex = boxes[0].start;
      var endIndex = boxes[0].end;
      var start = fcoords[startIndex];
      var end = fcoords[endIndex];

      if (boxes.length > 1) { // avoid distance calculation
        for (var i = 0, len = boxes.length; i < len; i++) {
          var box = boxes[i];
          var A = fcoords[boxes[i].start];
          var B = fcoords[boxes[i].end];
          var dist = geometry.pointSegmentDistance(pos, A, B);

          if (dist < d) {
            d = dist;
            start = A;
            end = B;
            startIndex = boxes[i].start;
            endIndex = boxes[i].end;
          }
        }
      }

      pos = geometry.closestPointOnSegment(pos, start, end);
      pos = [pos[1], pos[0]];
      pos.start = startIndex;
      pos.end = endIndex;

      return pos;
    } else {
      return null;
    }
  },

  /**
   * Builds R-Tree for the feature
   */
  _buildTree: function() {
    var coords = this._feature.geometry.coordinates,
      data = [];

    if (this._tree) {
      this._tree.clear();
    } else {
      this._tree = rbush();
    }

    for (var i = 1, len = coords.length; i < len; i++) {
      var obj = this._toTreeNode(coords[i - 1], coords[i]);
      obj.start = i - 1;
      obj.end = i;
      data.push(obj);
    }
    this._tree.load(data);
  },

  /**
   * Two points to BBOX node for RBush
   *
   * @param  {Array.<Number>} a
   * @param  {Array.<Number>} b
   * @return {Array.<Number>}
   */
  _toTreeNode: function(a, b) {
    var xmin = a[0],
      xmax = b[0],
      ymin = a[1],
      ymax = b[1];

    if (xmin > xmax) {
      xmax = a[0];
      xmin = b[0];
    }

    if (ymin > ymax) {
      ymax = a[1];
      ymin = b[1];
    }

    return [xmin, ymin, xmax, ymax];
  }

});

module.exports = Select;