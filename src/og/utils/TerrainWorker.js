'use sctrict';

import { QueueArray } from '../QueueArray.js';

class TerrainWorker {
    constructor(numWorkers = 2) {
        this._id = 0;
        this._segments = {};

        this._workerQueue = [];//new QueueArray(numWorkers);
        var elevationProgramm = new Blob([_programm], { type: 'application/javascript' });

        var that = this;
        for (let i = 0; i < numWorkers; i++) {
            var w = new Worker(URL.createObjectURL(elevationProgramm));
            w.onmessage = function (e) {

                that._segments[e.data.id]._terrainWorkerCallback(e.data);
                that._segments[e.data.id] = null;
                delete that._segments[e.data.id];

                that._workerQueue.unshift(this);
                that.check();
            };

            this._workerQueue.push(w);
        }

        this._pendingQueue = [];//new QueueArray(512);
    }

    check() {
        if (this._pendingQueue.length) {
            var p = this._pendingQueue.pop();
            this.make(p.segment, p.elevations);
        }
    }

    make(segment, elevations) {

        if (segment.plainReady && segment.terrainIsLoading) {

            var _elevations = new Float32Array(elevations.length);
            _elevations.set(elevations);

            if (this._workerQueue.length) {

                var w = this._workerQueue.pop();

                this._segments[this._id] = segment;

                w.postMessage({
                    'elevations': _elevations,
                    'this_plainVertices': segment.plainVertices,
                    'this_plainNormals': segment.plainNormals,
                    'this_normalMapVertices': segment.normalMapVertices,
                    'this_normalMapNormals': segment.normalMapNormals,
                    'heightFactor': segment.planet._heightFactor,
                    'gridSize': segment.planet.terrain.gridSizeByZoom[segment.tileZoom],
                    'id': this._id++
                }, [
                        _elevations.buffer,
                        segment.plainVertices.buffer,
                        segment.plainNormals.buffer,
                        segment.normalMapVertices.buffer,
                        segment.normalMapNormals.buffer
                    ]);
            } else {
                this._pendingQueue.push({ 'segment': segment, 'elevations': _elevations });
            }
        } else {
            this.check();
        }
    }
};

const _programm =
    `
    'use strict';

    var Vec3 = function(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
    };

    var doubleToTwoFloats = function(v, high, low) {

        let x = v.x, y = v.y, z = v.z;
    
        if (x >= 0.0) {
            var doubleHigh = Math.floor(x / 65536.0) * 65536.0;
            high.x = Math.fround(doubleHigh);
            low.x = Math.fround(x - doubleHigh);
        } else {
            var doubleHigh = Math.floor(-x / 65536.0) * 65536.0;
            high.x = Math.fround(-doubleHigh);
            low.x = Math.fround(x + doubleHigh);
        }

        if (y >= 0.0) {
            var doubleHigh = Math.floor(y / 65536.0) * 65536.0;
            high.y = Math.fround(doubleHigh);
            low.y = Math.fround(y - doubleHigh);
        } else {
            var doubleHigh = Math.floor(-y / 65536.0) * 65536.0;
            high.y = Math.fround(-doubleHigh);
            low.y = Math.fround(y + doubleHigh);
        }

        if (z >= 0.0) {
            var doubleHigh = Math.floor(z / 65536.0) * 65536.0;
            high.z = Math.fround(doubleHigh);
            low.z = Math.fround(z - doubleHigh);
        } else {
            var doubleHigh = Math.floor(-z / 65536.0) * 65536.0;
            high.z = Math.fround(-doubleHigh);
            low.z = Math.fround(z + doubleHigh);
        }
    };

    Vec3.prototype.sub = function(v) {
        return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z);
    };

    Vec3.prototype.add = function(v) {
        return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z);
    };

    Vec3.prototype.cross = function(v) {
        return new Vec3(
            this.y * v.z - this.z * v.y,
            this.z * v.x - this.x * v.z,
            this.x * v.y - this.y * v.x
        );
    };

    Vec3.prototype.normalize = function(v) {
        var x = this.x, y = this.y, z = this.z;
        var length = 1.0 / Math.sqrt(x * x + y * y + z * z);
        this.x = x * length;
        this.y = y * length;
        this.z = z * length;
        return this;
    };
    
    var slice = function (t, h1, h0) {
      return t * (h1 - h0);
    };

    var _tempVec = new Vec3(0.0, 0.0, 0.0);

    var _tempHigh = new Vec3(0.0, 0.0, 0.0),
        _tempLow = new Vec3(0.0, 0.0, 0.0);

    self.onmessage = function (e) {         
        var elevations = e.data.elevations,
            this_plainVertices = e.data.this_plainVertices,
            this_plainNormals = e.data.this_plainNormals,
            this_normalMapVertices = e.data.this_normalMapVertices,
            this_normalMapNormals = e.data.this_normalMapNormals,
            heightFactor =  e.data.heightFactor,
            //fileGridSize = e.data.fileGridSize,
            gridSize = e.data.gridSize,
            id = e.data.id;
        
        var xmin = 549755748352.0, xmax = -549755748352.0, 
            ymin = 549755748352.0, ymax = -549755748352.0, 
            zmin = 549755748352.0, zmax = -549755748352.0;

        const fileGridSize = Math.sqrt(elevations.length) - 1;

        const fileGridSize_one = fileGridSize + 1;
        const fileGridSize_one_x2 = fileGridSize_one * fileGridSize_one;
        const tgs = gridSize;
        const dg = fileGridSize / tgs;
        const gs = tgs + 1;
        const hf = heightFactor;

        var nmvInd = 0,
            vInd = 0;

        var gsgs3 = gs * gs * 3;

        var terrainVertices = new Float64Array(gsgs3),
            terrainVerticesHigh = new Float32Array(gsgs3),
            terrainVerticesLow = new Float32Array(gsgs3);

        var normalMapNormals,
            normalMapVertices,
            normalMapVerticesHigh,
            normalMapVerticesLow;

        var nv = this_normalMapVertices,
            nn = this_normalMapNormals;

        if (fileGridSize >= tgs) {

            normalMapNormals = new Float32Array(fileGridSize_one_x2 * 3),
            normalMapVertices = new Float64Array(fileGridSize_one_x2 * 3),
            normalMapVerticesHigh = new Float32Array(fileGridSize_one_x2 * 3),
            normalMapVerticesLow = new Float32Array(fileGridSize_one_x2 * 3);

                for (var k = 0; k < fileGridSize_one_x2; k++) {

                    var j = k % fileGridSize_one,
                        i = ~~(k / fileGridSize_one);

                    //
                    // V0
                    //
                    var hInd0 = k;
                    var vInd0 = hInd0 * 3;
                    var h0 = hf * elevations[hInd0];
                    var v0 = new Vec3(nv[vInd0] + h0 * nn[vInd0], nv[vInd0 + 1] + h0 * nn[vInd0 + 1], nv[vInd0 + 2] + h0 * nn[vInd0 + 2]);

                    doubleToTwoFloats(v0, _tempHigh, _tempLow);

                    normalMapVertices[vInd0] = v0.x;
                    normalMapVertices[vInd0 + 1] = v0.y;
                    normalMapVertices[vInd0 + 2] = v0.z;

                    normalMapVerticesHigh[vInd0] = _tempHigh.x;
                    normalMapVerticesHigh[vInd0 + 1] = _tempHigh.y;
                    normalMapVerticesHigh[vInd0 + 2] = _tempHigh.z;

                    normalMapVerticesLow[vInd0] = _tempLow.x;
                    normalMapVerticesLow[vInd0 + 1] = _tempLow.y;
                    normalMapVerticesLow[vInd0 + 2] = _tempLow.z;

                    if (i % dg === 0 && j % dg === 0) {

                        terrainVerticesHigh[vInd] = _tempHigh.x;
                        terrainVerticesLow[vInd] = _tempLow.x;
                        terrainVertices[vInd++] = v0.x;

                        terrainVerticesHigh[vInd] = _tempHigh.y;
                        terrainVerticesLow[vInd] = _tempLow.y;
                        terrainVertices[vInd++] = v0.y;

                        terrainVerticesHigh[vInd] = _tempHigh.z;
                        terrainVerticesLow[vInd] = _tempLow.z;
                        terrainVertices[vInd++] = v0.z;

                        if(h0 >= 0.0){
                            if (v0.x < xmin) xmin = v0.x; if (v0.x > xmax) xmax = v0.x;
                            if (v0.y < ymin) ymin = v0.y; if (v0.y > ymax) ymax = v0.y;
                            if (v0.z < zmin) zmin = v0.z; if (v0.z > zmax) zmax = v0.z;
                        }
                    }

                    if (i !== fileGridSize && j !== fileGridSize) {

                        //
                        //  V1
                        //
                        var hInd1 = k + 1;
                        var vInd1 = hInd1 * 3;
                        var h1 = hf * elevations[hInd1];
                        var v1 = new Vec3(nv[vInd1] + h1 * nn[vInd1], nv[vInd1 + 1] + h1 * nn[vInd1 + 1], nv[vInd1 + 2] + h1 * nn[vInd1 + 2]);

                        doubleToTwoFloats(v1, _tempHigh, _tempLow);

                        normalMapVertices[vInd1] = v1.x;
                        normalMapVertices[vInd1 + 1] = v1.y;
                        normalMapVertices[vInd1 + 2] = v1.z;

                        normalMapVerticesHigh[vInd1] = _tempHigh.x;
                        normalMapVerticesHigh[vInd1 + 1] = _tempHigh.y;
                        normalMapVerticesHigh[vInd1 + 2] = _tempHigh.z;

                        normalMapVerticesLow[vInd1] = _tempLow.x;
                        normalMapVerticesLow[vInd1 + 1] = _tempLow.y;
                        normalMapVerticesLow[vInd1 + 2] = _tempLow.z;

                        //
                        //  V2
                        //
                        var hInd2 = k + fileGridSize_one;
                        var vInd2 = hInd2 * 3;
                        var h2 = hf * elevations[hInd2];
                        var v2 = new Vec3(
                            nv[vInd2] + h2 * nn[vInd2],
                            nv[vInd2 + 1] + h2 * nn[vInd2 + 1],
                            nv[vInd2 + 2] + h2 * nn[vInd2 + 2]);

                        doubleToTwoFloats(v2, _tempHigh, _tempLow);

                        normalMapVertices[vInd2] = v2.x;
                        normalMapVertices[vInd2 + 1] = v2.y;
                        normalMapVertices[vInd2 + 2] = v2.z;

                        normalMapVerticesHigh[vInd2] = _tempHigh.x;
                        normalMapVerticesHigh[vInd2 + 1] = _tempHigh.y;
                        normalMapVerticesHigh[vInd2 + 2] = _tempHigh.z;

                        normalMapVerticesLow[vInd2] = _tempLow.x;
                        normalMapVerticesLow[vInd2 + 1] = _tempLow.y;
                        normalMapVerticesLow[vInd2 + 2] = _tempLow.z;

                        //
                        //  V3
                        //
                        var hInd3 = k + fileGridSize_one + 1;
                        var vInd3 = hInd3 * 3;
                        var h3 = hf * elevations[hInd3];
                        var v3 = new Vec3(nv[vInd3] + h3 * nn[vInd3], nv[vInd3 + 1] + h3 * nn[vInd3 + 1], nv[vInd3 + 2] + h3 * nn[vInd3 + 2]);

                        doubleToTwoFloats(v3, _tempHigh, _tempLow);

                        normalMapVertices[vInd3] = v3.x;
                        normalMapVertices[vInd3 + 1] = v3.y;
                        normalMapVertices[vInd3 + 2] = v3.z;

                        normalMapVerticesHigh[vInd3] = _tempHigh.x;
                        normalMapVerticesHigh[vInd3 + 1] = _tempHigh.y;
                        normalMapVerticesHigh[vInd3 + 2] = _tempHigh.z;

                        normalMapVerticesLow[vInd3] = _tempLow.x;
                        normalMapVerticesLow[vInd3 + 1] = _tempLow.y;
                        normalMapVerticesLow[vInd3 + 2] = _tempLow.z;

                        //
                        // Normal
                        //
                        var e10 = v1.sub(v0),
                            e20 = v2.sub(v0),
                            e30 = v3.sub(v0);
                        var sw = e20.cross(e30).normalize();
                        var ne = e30.cross(e10).normalize();
                        var n0 = ne.add(sw).normalize();

                        normalMapNormals[vInd0] += n0.x;
                        normalMapNormals[vInd0 + 1] += n0.y;
                        normalMapNormals[vInd0 + 2] += n0.z;

                        normalMapNormals[vInd1] += ne.x;
                        normalMapNormals[vInd1 + 1] += ne.y;
                        normalMapNormals[vInd1 + 2] += ne.z;

                        normalMapNormals[vInd2] += sw.x;
                        normalMapNormals[vInd2 + 1] += sw.y;
                        normalMapNormals[vInd2 + 2] += sw.z;

                        normalMapNormals[vInd3] += n0.x;
                        normalMapNormals[vInd3 + 1] += n0.y;
                        normalMapNormals[vInd3 + 2] += n0.z;
                    }
                }

        } else {

            normalMapNormals = new Float32Array(gsgs3),
            normalMapVertices = new Float64Array(gsgs3),
            normalMapVerticesHigh = new Float32Array(gsgs3),
            normalMapVerticesLow = new Float32Array(gsgs3);

            var plain_verts = this_plainVertices;
            var plainNormals = this_plainNormals;

            var oneSize = tgs / fileGridSize;
            var h, inside_i, inside_j, v_i, v_j;

            for (var i = 0; i < gs; i++) 
            {
                if (i == gs - 1) {
                    inside_i = oneSize;
                    v_i = Math.floor(i / oneSize) - 1;
                } else {
                    inside_i = i % oneSize;
                    v_i = Math.floor(i / oneSize);
                }

                for (var j = 0; j < gs; j++) 
                {
                    if (j == gs - 1) {
                        inside_j = oneSize;
                        v_j = Math.floor(j / oneSize) - 1;
                    } else {
                        inside_j = j % oneSize;
                        v_j = Math.floor(j / oneSize);
                    }

                    var hvlt = elevations[v_i * fileGridSize_one + v_j],
                        hvrt = elevations[v_i * fileGridSize_one + v_j + 1],
                        hvlb = elevations[(v_i + 1) * fileGridSize_one + v_j],
                        hvrb = elevations[(v_i + 1) * fileGridSize_one + v_j + 1];

                    if (inside_i + inside_j < oneSize) {
                        h = hf * (hvlt + slice(inside_j / oneSize, hvrt, hvlt) + slice(inside_i / oneSize, hvlb, hvlt));
                    } else {
                        h = hf * (hvrb + slice((oneSize - inside_j) / oneSize, hvlb, hvrb) + slice((oneSize - inside_i) / oneSize, hvrt, hvrb));
                    }

                    _tempVec.x = plain_verts[vInd] + h * plainNormals[vInd],
                    _tempVec.y = plain_verts[vInd + 1] + h * plainNormals[vInd + 1],
                    _tempVec.z = plain_verts[vInd + 2] + h * plainNormals[vInd + 2];

                    doubleToTwoFloats(_tempVec, _tempHigh, _tempLow);

                    terrainVertices[vInd] = _tempVec.x;
                    terrainVertices[vInd + 1] = _tempVec.y;
                    terrainVertices[vInd + 2] = _tempVec.z;

                    terrainVerticesHigh[vInd] = _tempHigh.x;
                    terrainVerticesHigh[vInd + 1] = _tempHigh.y;
                    terrainVerticesHigh[vInd + 2] = _tempHigh.z;

                    terrainVerticesLow[vInd] = _tempLow.x;
                    terrainVerticesLow[vInd + 1] = _tempLow.y;
                    terrainVerticesLow[vInd + 2] = _tempLow.z;

                    vInd += 3;

                    if(hvlt >= 0.0 && hvrt >= 0.0 && hvlb >= 0.0 && hvrb >= 0.0) {
                        if (_tempVec.x < xmin) xmin = _tempVec.x; if (_tempVec.x > xmax) xmax = _tempVec.x;
                        if (_tempVec.y < ymin) ymin = _tempVec.y; if (_tempVec.y > ymax) ymax = _tempVec.y;
                        if (_tempVec.z < zmin) zmin = _tempVec.z; if (_tempVec.z > zmax) zmax = _tempVec.z;
                    }
                }
            }

            normalMapNormals = new Float32Array(terrainVertices.length);

            var gridSize = tgs + 1;
            for(var k=0;k < terrainVertices.length / 3; k++) {

                var j = k % gridSize,
                    i = ~~(k / gridSize);

                if (i !== tgs && j !== tgs) {
                    var v0ind = k * 3,
                        v1ind = v0ind + 3,
                        v2ind = v0ind + gridSize * 3,
                        v3ind = v2ind + 3;

                        var v0 = new Vec3(terrainVertices[v0ind], terrainVertices[v0ind + 1], terrainVertices[v0ind + 2]),
                            v1 = new Vec3(terrainVertices[v1ind], terrainVertices[v1ind + 1], terrainVertices[v1ind + 2]),
                            v2 = new Vec3(terrainVertices[v2ind], terrainVertices[v2ind + 1], terrainVertices[v2ind + 2]),
                            v3 = new Vec3(terrainVertices[v3ind], terrainVertices[v3ind + 1], terrainVertices[v3ind + 2]);

                            var e10 = v1.sub(v0).normalize(),
                                e20 = v2.sub(v0).normalize(),
                                e30 = v3.sub(v0).normalize();

                            var sw = e20.cross(e30).normalize();
                            var ne = e30.cross(e10).normalize();
                            var n0 = ne.add(sw).normalize();

                            normalMapNormals[v0ind] += n0.x;
                            normalMapNormals[v0ind + 1] += n0.y;
                            normalMapNormals[v0ind + 2] += n0.z;

                            normalMapNormals[v1ind] += ne.x;
                            normalMapNormals[v1ind + 1] += ne.y;
                            normalMapNormals[v1ind + 2] += ne.z;

                            normalMapNormals[v2ind] += sw.x;
                            normalMapNormals[v2ind + 1] += sw.y;
                            normalMapNormals[v2ind + 2] += sw.z;

                            normalMapNormals[v3ind] += n0.x;
                            normalMapNormals[v3ind + 1] += n0.y;
                            normalMapNormals[v3ind + 2] += n0.z;
                    }
            }

            //normalMapNormals = this_plainNormals;

        }
        
        var normalMapNormalsRaw = new Float32Array(normalMapNormals.length);
        normalMapNormalsRaw.set(normalMapNormals);

        self.postMessage({
                id: id,
                normalMapNormals: normalMapNormals,
                normalMapNormalsRaw: normalMapNormalsRaw,
                normalMapVertices: normalMapVertices,
                normalMapVerticesHigh: normalMapVerticesHigh,
                normalMapVerticesLow: normalMapVerticesLow,
                terrainVertices: terrainVertices,
                terrainVerticesHigh: terrainVerticesHigh,
                terrainVerticesLow: terrainVerticesLow,
                bounds: [xmin, xmax, ymin, ymax, zmin, zmax]
             }, [
                    normalMapNormals.buffer, 
                    normalMapNormalsRaw.buffer, 
                    normalMapVertices.buffer, 
                    normalMapVerticesHigh.buffer, 
                    normalMapVerticesLow.buffer, 
                    terrainVertices.buffer,
                    terrainVerticesHigh.buffer,
                    terrainVerticesLow.buffer
            ]);
    }`;

export { TerrainWorker };