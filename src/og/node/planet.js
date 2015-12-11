goog.provide('og.node.Planet');

goog.require('og.inheritance');
goog.require('og.node.RenderNode');
goog.require('og.math');
goog.require('og.math.Matrix4');
goog.require('og.math.Vector3');
goog.require('og.math.Vector2');
goog.require('og.math.coder');
goog.require('og.quadTree');
goog.require('og.quadTree.QuadNode');
goog.require('og.bv.Sphere');
goog.require('og.PlanetCamera');
goog.require('og.shaderProgram.overlays_wl');
goog.require('og.shaderProgram.overlays_nl');
goog.require('og.shaderProgram.single_nl');
goog.require('og.shaderProgram.single_wl');
goog.require('og.shaderProgram.heightPicking');
goog.require('og.layer');
goog.require('og.planetSegment');
goog.require('og.planetSegment.Wgs84PlanetSegment');
goog.require('og.planetSegment.PlanetSegmentHelper');
goog.require('og.Extent');
goog.require('og.math.Ray');
goog.require('og.webgl.Framebuffer');
goog.require('og.mercator');
goog.require('og.proj.EPSG4326');
goog.require('og.ImageCanvas');
goog.require('og.light.PointLight');
goog.require('og.planetSegment.NormalMapCreatorQueue');
goog.require('og.planetSegment.GeoImageTileCreatorQueue');

/**
 * Main class for rendering planet
 *
 * @extends {og.node.RenderNode}
 * @param {string} name - Planet name(Earth by default)
 * @param {og.Ellipsoid} ellipsoid - Planet ellipsoid(WGS84 by default)
 * @fires og.Event#draw
 * @fires og.Event#layeradd
 * @fires og.Event#baselayerchange
 * @fires og.Event#layerremove
 * @fires og.Event#layervisibilitychange
 * @fires og.Event#geoimageadd
 */
og.node.Planet = function (name, ellipsoid) {
    og.inheritance.base(this, name);
    this.ellipsoid = ellipsoid;
    this.quadTree = null;
    this.quadTreeNorth = null;
    this.quadTreeSouth = null;

    /**
     * All layers array
     * @type {Array.<og.layer.Layer>}
     */
    this.layers = [];

    /**
     * Current visible layers array
     * @type {Array.<og.layer.Layer>}
     */
    this.visibleLayers = [];

    this.tcolorArr = [];

    /**
     * There is only one base layer on the globe when layer.isBaseLayer is true.
     * @type {og.layer.Layer}
     */
    this.baseLayer = null;

    this.terrainProvider = null;

    //this.renderer.activeCamera pointer
    this.camera = null;

    this.createdNodesCount = 0;
    this.renderedNodes = [];

    /**
     * Height scale factor. 1 - is normal elevation scale
     * @type {number}
     */
    this.heightFactor = 1.0;

    this.mousePositionOnEarth = new og.math.Vector3();

    this.indexesBuffers = [];
    this._heightBackbuffer = null;
    this._currentDistanceFromPixel = 0;
    this._viewChanged = true;

    this.emptyTexture = null;
    this.transparentTexture = null;
    this.defaultTexture = null;

    /**
     * Point light source.
     * @type {og.light.PointLight}
     */
    this.sunlight = null;

    this.normalMapCreator = null;
    this.geoImageTileCreator = null;

    this.geoImagesArray = [];

    this.minCurrZoom = og.math.MAX;
    this.maxCurrZoom = og.math.MIN;

    //events initialization
    this.events.registerNames(og.node.Planet.EVENT_NAMES);

    this._isCameraSunlight = false;
};

og.inheritance.extend(og.node.Planet, og.node.RenderNode);

/**
 * Planet node events names
 * @type {Array.<string>}
 * @const
 */
og.node.Planet.EVENT_NAMES = [
        /**
         * Triggered before globe frame begins to render.
         * @event og.Events#draw
         */
        "draw",

        /**
         * Triggered when layer has added to the planet.
         * @event og.Events#layeradd
         */
        "layeradd",

        /**
         * Triggered when base layer changed.
         * @event og.Events#baselayerchange
         */
        "baselayerchange",

        /**
         * Triggered when layer has removed from the planet.
         * @event og.Events#layerremove
         */
        "layerremove",

        /**
         * Triggered when some layer visibility changed.
         * @event og.Events#layervisibilitychange
         */
        "layervisibilitychange",

        /**
         * Triggered when geo image added.
         * @event og.Events#geoimageadd
         */
        "geoimageadd"];

/**
 * Distance from center of scene to the Sun
 * @type {number}
 * @const
 */
og.node.Planet.SUN_DISTANCE = 149600000000;

/**
 * Default planet empty color
 * @type {string}
 * @const
 */
og.node.Planet.defaultEmptyColor = "#C5C5C5";

og.node.Planet.prototype.createDefaultTexture = function (params) {
    var imgCnv;
    var texture;
    if (params && params.color) {
        imgCnv = new og.ImageCanvas(2, 2);
        imgCnv.fillColor(params.color);
        texture = this.renderer.handler.createTexture(imgCnv._canvas);
    } else if (params && params.url) {
        imgCnv = new og.ImageCanvas(params.width || 256, params.height || 256);
        var that = this;
        imgCnv.loadImage(params.url, function (img) {
            texture = that.renderer.handler.createTexture(img);
            texture.default = true;
        });
    } else {
        imgCnv = new og.ImageCanvas(2, 2);
        imgCnv.fillColor(og.node.Planet.defaultEmptyColor);
        texture = this.renderer.handler.createTexture(imgCnv._canvas);
    }
    texture.default = true;
    return texture;
};

/**
 * Return layer by it name
 * @param {string} name - Name of the layer. og.layer.Layer.prototype.name
 * @public
 * @returns {og.layer.Layer}
 */
og.node.Planet.prototype.getLayerByName = function (name) {
    var i = this.layers.length;
    while (i--) {
        if (this.layers[i].name === name)
            return this.layers[i];
    }
    return undefined;
};

og.node.Planet.prototype.addGeoImage = function (geoImage) {
    geoImage.addTo(this);
};

/**
 * Adds the given layer to the planet.
 * @param {og.layer.Layer} layer - Layer object.
 * @public
 */
og.node.Planet.prototype.addLayer = function (layer) {
    layer.planet = this;
    layer.events.on("visibilitychange", this, this._onLayerVisibilityChanged);
    if (layer.isBaseLayer && layer.visibility) {
        this.setBaseLayer(layer);
    }
    this.layers.push(layer);
    this.events.dispatch(this.events.layeradd, layer);
    layer.events.dispatch(layer.events.add, this);
    this.updateVisibleLayers();
};

/**
 * Dispatch layer visibility changing event.
 * @param {og.layer.Layer} layer - Changed layer.
 * @private
 */
og.node.Planet.prototype._onLayerVisibilityChanged = function (layer) {
    this.events.dispatch(this.events.layervisibilitychange, layer);
};

/**
 * Adds the given layers array to the planet.
 * @param {Array.<og.layer.Layer>} layers - Layers array.
 * @public
 */
og.node.Planet.prototype.addLayers = function (layers) {
    for (var i = 0; i < layers.length; i++) {
        this.addLayer(layers[i]);
    }
};

/**
 * Removes the given layer from the planet.
 * @param {og.layer.Layer} layer - Layer to remove.
 * @return {og.layer.Layer|undefined} The removed layer or undefined if the layer was not found.
 * @public
 */
og.node.Planet.prototype.removeLayer = function (layer) {
    var lid = layer.id;
    for (var i = 0; i < this.layers.length; i++) {
        if (this.layers[i].id == lid) {
            this.layers.splice(i, 1);
            layer.setVisibility(false);
            layer.abortLoading();
            this.quadTree.traverseTree(function (node) {
                var mats = node.planetSegment.materials;
                if (mats[lid]) {
                    mats[lid].clear();
                    mats[lid] = null;
                }
            });
            this.events.dispatch(this.events.layerremove, layer);
            layer.events.dispatch(layer.events.remove, this);
            layer.planet = null;
            return layer;
        }
    }
    return undefined;
};

/**
 * @private
 */
og.node.Planet.prototype.redrawGeoImages = function () {
    this.geoImagesArray.sort(function (a, b) {
        return b.zIndex - a.zIndex;
    });
    var refresh = function (node) {
        node.planetSegment.geoImageReady = false;
    }
    this.quadTree.traverseTree(refresh);
    this.quadTreeNorth.traverseTree(refresh);
    this.quadTreeSouth.traverseTree(refresh);
};

/**
 * Get the collection of layers associated with this planet.
 * @return {Array.<og.layer.Layer>} Layers.
 * @public
 */
og.node.Planet.prototype.getLayers = function () {
    return this.layers;
};

/**
 * Sets base layer coverage to the planet.
 * @param {og.layer.Layer} layer - Layer object.
 * @public
 */
og.node.Planet.prototype.setBaseLayer = function (layer) {
    if (this.baseLayer) {
        if (layer.id != this.baseLayer.id) {
            for (var i = 0; i < this.layers.length; i++) {
                var li = this.layers[i];
                if (li.isBaseLayer) {
                    li.visibility = false;
                    if (li.id != layer.id)
                        li.events.dispatch(li.events.visibilitychange, li);
                }
            }
            layer.visibility = true;
            layer.events.dispatch(layer.events.visibilitychange, layer);
            this.baseLayer.abortLoading();
            this.baseLayer = layer;
        }
    } else {
        this.baseLayer = layer;
        this.baseLayer.setVisibility(true);
    }
    this.events.dispatch(this.events.baselayerchange, layer);
    this.updateVisibleLayers();
};

/**
 * Sets elevation scale. 1.0 is default.
 * @param {number} factor - Elevation scale.
 */
og.node.Planet.prototype.setHeightFactor = function (factor) {
    if (this.heightFactor !== factor) {
        this.heightFactor = factor;
        this.quadTree.reloadTerrain();
    }
};

og.node.Planet.prototype.setTerrainProvider = function (terrain) {
    this.terrainProvider = terrain;
};

og.node.Planet.prototype.initialization = function () {
    //Initialization indexes table
    og.planetSegment.PlanetSegmentHelper.initIndexesTables(6);

    //Iniytialize indexes buffers array
    for (var i = 0; i <= 6; i++) {
        var gridSize = Math.pow(2, i);
        var indexes = og.planetSegment.PlanetSegmentHelper.createSegmentIndexes(gridSize, [gridSize, gridSize, gridSize, gridSize]);
        this.indexesBuffers[gridSize] = this.renderer.handler.createElementArrayBuffer(indexes, 1, indexes.length);
    }

    //create empty textures
    this.solidTexture = this.createDefaultTexture({ color: "rgba(197,197,197,1.0)" });
    this.transparentTexture = this.createDefaultTexture({ color: "rgba(0,0,0,0.0)" });

    this.camera = this.renderer.activeCamera = new og.PlanetCamera(this, { eye: new og.math.Vector3(0, 0, 28000000), look: new og.math.Vector3(0, 0, 0), up: new og.math.Vector3(0, 1, 0) });

    //Creating quad trees nodes
    this.quadTree = og.quadTree.QuadNode.createNode(og.planetSegment.PlanetSegment, this, og.quadTree.NW, null, 0, 0, og.Extent.createFromArray([-20037508.34, -20037508.34, 20037508.34, 20037508.34]));
    this.quadTreeNorth = og.quadTree.QuadNode.createNode(og.planetSegment.Wgs84PlanetSegment, this, og.quadTree.NW, null, 0, 0, og.Extent.createFromArray([-180, og.mercator.MAX_LAT, 180, 90]));
    this.quadTreeSouth = og.quadTree.QuadNode.createNode(og.planetSegment.Wgs84PlanetSegment, this, og.quadTree.NW, null, 0, 0, og.Extent.createFromArray([-180, -90, 180, og.mercator.MIN_LAT]));

    //Just initials
    this.renderer.activeCamera.cameraInsideNode = this.quadTree;
    this.drawMode = this.renderer.handler.gl.TRIANGLE_STRIP;
    this.setScale(new og.math.Vector3(1.0, this.ellipsoid._a / this.ellipsoid._b, 1.0));
    this.updateMatrices();

    //Applying shaders
    this.renderer.handler.addShaderProgram(og.shaderProgram.single_nl(), true);
    this.renderer.handler.addShaderProgram(og.shaderProgram.single_wl(), true);
    this.renderer.handler.addShaderProgram(og.shaderProgram.overlays_nl(), true);
    this.renderer.handler.addShaderProgram(og.shaderProgram.overlays_wl(), true);
    this.renderer.handler.addShaderProgram(og.shaderProgram.heightPicking(), true);

    //backbuffer initialization
    this._heightBackbuffer = new og.webgl.Framebuffer(this.renderer.handler);

    this.updateVisibleLayers();

    this.renderer.events.on("resize", this._heightBackbuffer, function (e) {
        this.setSize(e.width, e.height);
    });
    this.renderer.activeCamera.events.on("viewchange", this, function (e) {
        this._viewChanged = true;
    });
    this.renderer.events.on("mousemove", this, function (e) {
        this._viewChanged = true;
    });
    this.renderer.events.on("touchmove", this, function (e) {
        this._viewChanged = true;
    });

    //sunlight initialization
    this.sunlight = new og.light.PointLight();
    this.sunlight._position.z = og.node.Planet.SUN_DISTANCE;
    this.sunlight.setAmbient(new og.math.Vector3(0.18, 0.13, 0.25));
    this.sunlight.setDiffuse(new og.math.Vector3(0.9, 0.9, 0.8));
    this.sunlight.setSpecular(new og.math.Vector3(0.008, 0.008, 0.005));
    this.sunlight.setShininess(4);
    this.sunlight.addTo(this);

    this.lightEnabled = true;

    //normal map renderer initialization
    this.normalMapCreator = new og.planetSegment.NormalMapCreatorQueue(128, 128);

    //normal map renderer initialization
    this.geoImageTileCreator = new og.planetSegment.GeoImageTileCreatorQueue(256, 256);

    //temporary initializations
    var that = this;
    this.renderer.events.on("charkeypress", this, function () { that.memClear(); }, og.input.KEY_C);
    this.renderer.events.on("charkeypress", this, function () { that.lightEnabled = !that.lightEnabled; }, og.input.KEY_L);
    this.renderer.events.on("keypress", this, function () {
        that._isCameraSunlight = true;
    }, og.input.KEY_V);

    this.renderer.assignPickingColor(this);
    this.renderer.addPickingCallback(this, this._planetPickingCallback);
};

/**
 * @private
 */
og.node.Planet.prototype.updateAttributionsList = function () {
    var html = "";
    for (var i = 0; i < this.layers.length; i++) {
        var li = this.layers[i];
        if (li.visibility) {
            if (li._attribution.length) {
                html += "<li>" + li._attribution + "</li>";
            }
        }
    }

    if (this.renderer) {
        if (html.length) {
            this.renderer.div.attributions.style.display = "block";
            this.renderer.div.attributions.innerHTML = "<ul>" + html + "</ul>";
        } else {
            this.renderer.div.attributions.style.display = "none";
            this.renderer.div.attributions.innerHTML = "";
        }
    }
};

og.node.Planet.prototype.updateVisibleLayers = function () {
    this.visibleLayers.length = 0;
    var html = "";
    for (var i = 0; i < this.layers.length; i++) {
        var li = this.layers[i];
        if (li.visibility) {
            if (li.isBaseLayer) {
                this.baseLayer = li;
            }
            this.visibleLayers.push(li);
            if (li._attribution.length) {
                html += "<li>" + li._attribution + "</li>";
            }
        }
    }

    if (this.renderer) {
        if (html.length) {
            this.renderer.div.attributions.style.display = "block";
            this.renderer.div.attributions.innerHTML = "<ul>" + html + "</ul>";
        } else {
            this.renderer.div.attributions.style.display = "none";
            this.renderer.div.attributions.innerHTML = "";
        }
    }

    this.sortVisibleLayersByZIndex();
};

og.node.Planet.prototype.sortVisibleLayersByZIndex = function () {
    this.visibleLayers.sort(function (a, b) {
        return a.isBaseLayer ? -1 : a.zIndex - b.zIndex;
    })
};

og.node.Planet.prototype.collectRenderNodes = function () {

    //clear first
    this.renderedNodes.length = 0;
    this.renderedNodes = [];

    this.minCurrZoom = og.math.MAX;
    this.maxCurrZoom = og.math.MIN;

    this.quadTreeNorth.renderTree();
    this.quadTreeSouth.renderTree();
    this.quadTree.renderTree();
};

/**
 * Render node callback.
 * @private
 */
og.node.Planet.prototype.frame = function () {

    var cam = this.renderer.activeCamera;

    cam.flyFrame();
    cam.checkCollision();

    //Here is the planet node dispatches a draw event before rendering begins.
    this.events.dispatch(this.events.draw, this);

    this.collectRenderNodes();

    //print2d("lbTiles", "min = " + this.minCurrZoom + ", max = " + this.maxCurrZoom, 100, 100);

    if (!this._isCameraSunlight)
        this.sunlight._position = cam.v.scaleTo(cam.altitude * 0.2).add(cam.u.scaleTo(cam.altitude * 0.4)).add(cam.eye);
    else
        this.sunlight._position = cam.eye;

    this._isCameraSunlight = false;

    this.transformLights();

    this.renderNodesPASS();
    this.renderHeightBackbufferPASS();

    //free memory
    var that = this;
    if (this.createdNodesCount > 1370) {
        setTimeout(function () {
            that.memClear();
        }, 0);
        that.createdNodesCount = 0;
    }
};

/**
 * Starts clear memory thread.
 */
og.node.Planet.prototype.memClear = function () {
    this.quadTree.clearTree();
    this.quadTreeNorth.clearTree();
    this.quadTreeSouth.clearTree();
};

/**
 * @private
 */
og.node.Planet.prototype.renderNodesPASS = function () {
    var sh, drawCallback;
    var renderer = this.renderer;
    var h = renderer.handler;
    var gl = h.gl;

    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);

    if (this.visibleLayers.length > 1) {

        drawCallback = og.planetSegment.drawOverlays;

        if (this.lightEnabled) {
            h.shaderPrograms.overlays_wl.activate();
            sh = h.shaderPrograms.overlays_wl._program,
            shu = sh.uniforms;

            gl.uniform3fv(shu.pointLightsPositions._pName, this._pointLightsTransformedPositions);
            gl.uniform3fv(shu.pointLightsParamsv._pName, this._pointLightsParamsv);
            gl.uniform1fv(shu.pointLightsParamsf._pName, this._pointLightsParamsf);

            gl.uniformMatrix3fv(shu.uNMatrix._pName, false, renderer.activeCamera.nMatrix._m);
            gl.uniformMatrix4fv(shu.uMVMatrix._pName, false, renderer.activeCamera.mvMatrix._m);
            gl.uniformMatrix4fv(shu.uPMatrix._pName, false, renderer.activeCamera.pMatrix._m);
            //h.gl.uniformMatrix4fv(sh.uniforms.uTRSMatrix._pName, false, this.transformationMatrix._m);

        } else {
            h.shaderPrograms.overlays_nl.activate();
            sh = h.shaderPrograms.overlays_nl._program;
            gl.uniformMatrix4fv(sh.uniforms.uPMVMatrix._pName, false, renderer.activeCamera.pmvMatrix._m);
        }

        var layers = this.visibleLayers;
        var i = layers.length;
        while (i--) {
            var ll = layers[i];
            var nt4 = i * 4;
            this.tcolorArr[nt4] = ll.transparentColor[0];
            this.tcolorArr[nt4 + 1] = ll.transparentColor[1];
            this.tcolorArr[nt4 + 2] = ll.transparentColor[2];
            this.tcolorArr[nt4 + 3] = ll.opacity;
        }

        gl.uniform1i(sh.uniforms.numTex._pName, layers.length);
        gl.uniform4fv(sh.uniforms.tcolorArr._pName, this.tcolorArr);

    } else {
        drawCallback = og.planetSegment.drawSingle;
        if (this.lightEnabled) {
            h.shaderPrograms.single_wl.activate();
            sh = h.shaderPrograms.single_wl._program,
            shu = sh.uniforms;

            gl.uniform3fv(shu.pointLightsPositions._pName, this._pointLightsTransformedPositions);
            gl.uniform3fv(shu.pointLightsParamsv._pName, this._pointLightsParamsv);
            gl.uniform1fv(shu.pointLightsParamsf._pName, this._pointLightsParamsf);

            gl.uniformMatrix3fv(shu.uNMatrix._pName, false, renderer.activeCamera.nMatrix._m);
            gl.uniformMatrix4fv(shu.uMVMatrix._pName, false, renderer.activeCamera.mvMatrix._m);
            gl.uniformMatrix4fv(shu.uPMatrix._pName, false, renderer.activeCamera.pMatrix._m);
            //h.gl.uniformMatrix4fv(sh.uniforms.uTRSMatrix._pName, false, this.transformationMatrix._m);
        } else {
            h.shaderPrograms.single_nl.activate();
            sh = h.shaderPrograms.single_nl._program;

            gl.uniformMatrix4fv(sh.uniforms.uPMVMatrix._pName, false, renderer.activeCamera.pmvMatrix._m);
        }
    }

    //draw planet's nodes
    var i = this.renderedNodes.length;
    while (i--) {
        drawCallback(sh, this.renderedNodes[i].planetSegment);
    }
    gl.disable(gl.BLEND);
};

/**
 * @private
 */
og.node.Planet.prototype.renderHeightBackbufferPASS = function () {
    var b = this._heightBackbuffer,
        r = this.renderer;
    var h = r.handler;
    var pp = h.shaderPrograms.heightPicking;
    h.gl.disable(h.gl.BLEND);
    b.activate();
    b.clear();
    pp.activate();
    h.gl.uniform3fv(pp._program.uniforms.camPos._pName, r.activeCamera.eye.toVec());
    var i = this.renderedNodes.length;
    while (i--) {
        this.renderedNodes[i].planetSegment.drawHeightPicking();
    }
    b.deactivate();
};

og.node.Planet.prototype._planetPickingCallback = function () {
    var r = this.renderer;
    var h = r.handler;
    var i = this.renderedNodes.length;
    //...
    //...
    while (i--) {
        this.renderedNodes[i].planetSegment.drawPicking();
    }
};

/**
 * Returns ray vector hit ellipsoid coordinates. 
 * If the ray doesn't hit ellipsoit returns null.
 * @public
 * @param {og.math.Vector3} origin - Ray origin point.
 * @param {og.math.VEctor3} direction - Ray direction.
 * @returns {og.math.Vector3}
 */
og.node.Planet.prototype.hitRayEllipsoid = function (origin, direction) {
    var mxTr = this.transformationMatrix.transpose();
    var sx = new og.math.Ray(mxTr.mulVec3(origin),
        mxTr.mulVec3(direction)).hitSphere(new og.bv.Sphere(this.ellipsoid._a));
    if (sx) {
        return this.itransformationMatrix.mulVec3(sx);
    }
    return null;
};

/**
 * Returns ray vector hit ellipsoid coordinates. 
 * If the ray doesn't hit ellipsoit returns null.
 * @public
 * @param {og.math.Ray} ray - Ray 3d.
 * @returns {og.math.Vector3}
 */
og.node.Planet.prototype.getRayIntersectionEllipsoid = function (ray) {
    return this.hitRayEllipsoid(ray.origin, ray.direction);
};

/**
 * Returns 2d screen coordanates projection point to the planet ellipsoid 3d coordinates.
 * @public
 * @param {og.math.Pixel} px - 2D sreen coordinates.
 */
og.node.Planet.prototype.getCartesianFromPixelEllipsoid = function (px) {
    var cam = this.renderer.activeCamera;
    return this.hitRayEllipsoid(cam.eye, cam.unproject(px.x, px.y));
};

/**
 * Returns 2d screen coordanates projection point to the planet ellipsoid geographical coordinates.
 * @public
 * @param {og.math.Pixel} px - 2D screen coordinates.
 * @returns {og.LonLat}
 */
og.node.Planet.prototype.getLonLatFromPixelEllipsoid = function (px) {
    var coords = this.getCartesianFromPixelEllipsoid(px);
    if (coords) {
        return this.ellipsoid.ECEF2LonLat(coords);
    }
    return null;
};

/**
 * Returns 3d cartesian coordinates on the relief planet by mouse cursor 
 * position or null if mouse cursor is outside the planet.
 * @public
 * @returns {og.math.Vector3}
 */
og.node.Planet.prototype.getCartesianFromMouseTerrain = function () {
    var ms = this.renderer.events.mouseState;
    var distance = this.getDistanceFromPixel(ms);
    if (distance) {
        return ms.direction.scaleTo(distance).add(this.renderer.activeCamera.eye);
    }
    return null;
};

/**
 * Returns 3d cartesian coordinates on the relief planet by 2d screen coordinates.
 * position or null if input coordinates is outside the planet.
 * @public
 * @param {og.math.Vector2} px - Pixel screen 2d coordinates.
 * @returns {og.math.Vector3}
 */
og.node.Planet.prototype.getCartesianFromPixelTerrain = function (px) {
    var distance = this.getDistanceFromPixel(px);
    if (distance) {
        var direction = this.renderer.activeCamera.unproject(px.x, px.y);
        return direction.scaleTo(distance).add(this.renderer.activeCamera.eye);
    }
    return null;
};

/**
 * Returns geographical coordinates on the relief planet by 2d screen coordinates.
 * position or null if input coordinates is outside the planet.
 * @public
 * @param {og.math.Vector2} px - Pixel screen 2d coordinates.
 * @returns {og.LonLat}
 */
og.node.Planet.prototype.getLonLatFromPixelTerrain = function (px) {
    var coords = this.getCartesianFromPixelTerrain(px);
    if (coords) {
        return this.ellipsoid.ECEF2LonLat(coords);
    }
    return null;
};

/**
 * Returns projected 2d screen coordinates by 3d cartesian coordiantes.
 * @public
 * @param {og.math.Vector3} coords - Cartesian coordinates.
 * @returns {og.math.Vector2}
 */
og.node.Planet.prototype.getPixelFromCartesian = function (coords) {
    return this.renderer.activeCamera.project(coords);
};

/**
 * Returns projected 2d screen coordinates by geographical coordinates.
 * @public
 * @param {og.LonLat} lonlat - Geographical coordinates.
 * @returns {og.math.Vector2}
 */
og.node.Planet.prototype.getPixelFromLonLat = function (lonlat) {
    var coords = this.ellipsoid.LonLat2ECEF(lonlat);
    if (coords)
        return this.renderer.activeCamera.project(coords);
    return null;
};

/**
 * Returns distance from active camera to the the planet ellipsoid 
 * coordiantes unprojected by 2d screen coordiantes, or null if screen coordinates outside the planet.
 * @public
 * @param {og.math.Vector2} px
 * @returns {number}
 */
og.node.Planet.prototype.getDistanceFromPixelEllipsoid = function (px) {
    var coords = this.getCartesianFromPixelEllipsoid(px);
    return coords ? coords.distance(this.renderer.activeCamera.eye) : null;
};

/**
 * Returns distance from active camera to the the relief planet coordiantes unprojected 
 * by 2d screen coordiantes, or null if screen coordinates outside the planet. 
 * If screen coordinates inside the planet but relief is not exists in the 
 * point than function returns distance to the planet ellipsoid.
 * @public
 * @param {og.math.Vector2} px
 * @returns {number}
 */
og.node.Planet.prototype.getDistanceFromPixel = function (px) {
    if (this._viewChanged) {
        this._viewChanged = false;
        var color = og.math.Vector4.fromVec(this._heightBackbuffer.readPixel(px.x, this._heightBackbuffer.height - px.y));
        if (!(color.x | color.y | color.z | color.w)) {
            return this.getDistanceFromPixelEllipsoid(px);
        }
        return this._currentDistanceFromPixel = og.math.coder.decodeFloatFromRGBA(color);
    }
    return this._currentDistanceFromPixel;
};

/**
 * Sets camera to the planet geographical extent.
 * @public
 * @param {og.Extent} extent - Geographical extent.
 */
og.node.Planet.prototype.viewExtent = function (extent) {
    this.renderer.activeCamera.viewExtent(extent);
};

/**
 * Sets camera to the planet geographical position.
 * @public
 * @param {og.LonLat} lonlat - New geographical position.
 * @param {og.math.Vector3} [up] - Camera UP vector.
 */
og.node.Planet.prototype.viewLonLat = function (lonlat, up) {
    this.renderer.activeCamera.viewLonLat(lonlat, up);
};

/**
 * Fly camera to the planet geographical extent.
 * @public
 * @param {og.Extent} extent - Geographical extent.
 * @param {og.math.Vector3} [up] - Camera UP vector on the end of a flying.
 */
og.node.Planet.prototype.flyExtent = function (extent, up) {
    this.renderer.activeCamera.flyExtent(extent, up);
};

/**
 * Fly camera to the new point.
 * @public
 * @param {og.math.Vector3} cartesian - Fly coordiantes.
 * @param {og.math.Vector3} [look] - Camera "look at" point.
 * @param {og.math.Vector3} [up] - Camera UP vector on the end of a flying.
 */
og.node.Planet.prototype.flyCartesian = function (cartesian, look, up) {
    this.renderer.activeCamera.flyCartesian(cartesian, look, up);
};

/**
 * Fly camera to the new geographical position.
 * @public
 * @param {og.LonLat} lonlat - Fly geographical coordiantes.
 * @param {og.math.Vector3} [look] - Camera "look at" point on the end of a flying.
 * @param {og.math.Vector3} [up] - Camera UP vector on the end of a flying.
 */
og.node.Planet.prototype.flyLonLat = function (lonlat, look, up) {
    this.renderer.activeCamera.flyLonLat(lonlat, look, up);
};

/**
 * Breaks the flight.
 * @public
 */
og.node.Planet.prototype.stopFlying = function () {
    this.renderer.activeCamera.stopFlying();
};