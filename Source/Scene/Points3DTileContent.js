/*global define*/
define([
        '../Core/Color',
        '../Core/combine',
        '../Core/ComponentDatatype',
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/destroyObject',
        '../Core/defineProperties',
        '../Core/DeveloperError',
        '../Core/getMagic',
        '../Core/getStringFromTypedArray',
        '../Core/loadArrayBuffer',
        '../Core/Matrix3',
        '../Core/Matrix4',
        '../Core/PrimitiveType',
        '../Core/Request',
        '../Core/RequestScheduler',
        '../Core/RequestType',
        '../Renderer/DrawCommand',
        '../Renderer/RenderState',
        '../Renderer/ShaderProgram',
        '../Renderer/VertexArray',
        '../ThirdParty/when',
        './BlendingState',
        './Cesium3DTileContentState',
        './Cesium3DTileFeatureTableResources',
        './Pass'
    ], function(
        Color,
        combine,
        ComponentDatatype,
        defaultValue,
        defined,
        destroyObject,
        defineProperties,
        DeveloperError,
        getMagic,
        getStringFromTypedArray,
        loadArrayBuffer,
        Matrix3,
        Matrix4,
        PrimitiveType,
        Request,
        RequestScheduler,
        RequestType,
        DrawCommand,
        RenderState,
        ShaderProgram,
        VertexArray,
        when,
        BlendingState,
        Cesium3DTileContentState,
        Cesium3DTileFeatureTableResources,
        Pass) {
    'use strict';

    /**
     * Represents the contents of a
     * {@link https://github.com/AnalyticalGraphicsInc/3d-tiles/blob/master/TileFormats/Points/README.md|Points}
     * tile in a {@link https://github.com/AnalyticalGraphicsInc/3d-tiles/blob/master/README.md|3D Tiles} tileset.
     *
     * @alias Points3DTileContent
     * @constructor
     *
     * @private
     */
    function Points3DTileContent(tileset, tile, url) {
        this._url = url;
        this._tileset = tileset;
        this._tile = tile;
        this._constantColor = Color.clone(Color.WHITE);
        this._pointSize = 2.0;
        this._quantizedVolumeScale = undefined;
        this._drawCommand = new DrawCommand();

        /**
         * The following properties are part of the {@link Cesium3DTileContent} interface.
         */
        this.state = Cesium3DTileContentState.UNLOADED;
        this.contentReadyToProcessPromise = when.defer();
        this.readyPromise = when.defer();
        this.batchTableResources = undefined;
        this.featurePropertiesDirty = false;
    }

    defineProperties(Points3DTileContent.prototype, {
        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        featuresLength : {
            get : function() {
                // TODO: implement batchTable for pnts tile format
                return 0;
            }
        },

        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        innerContents : {
            get : function() {
                return undefined;
            }
        }
    });

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Points3DTileContent.prototype.hasProperty = function(name) {
        // TODO: implement batchTable for pnts tile format
        return false;
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Points3DTileContent.prototype.getFeature = function(batchId) {
        // TODO: implement batchTable for pnts tile format
        return undefined;
    };

    var sizeOfUint32 = Uint32Array.BYTES_PER_ELEMENT;

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Points3DTileContent.prototype.request = function() {
        var that = this;

        var distance = this._tile.distanceToCamera;
        var promise = RequestScheduler.schedule(new Request({
            url : this._url,
            server : this._tile.requestServer,
            requestFunction : loadArrayBuffer,
            type : RequestType.TILES3D,
            distance : distance
        }));
        if (defined(promise)) {
            this.state = Cesium3DTileContentState.LOADING;
            promise.then(function(arrayBuffer) {
                if (that.isDestroyed()) {
                    return when.reject('tileset is destroyed');
                }
                that.initialize(arrayBuffer);
            }).otherwise(function(error) {
                that.state = Cesium3DTileContentState.FAILED;
                that.readyPromise.reject(error);
            });
        }
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Points3DTileContent.prototype.initialize = function(arrayBuffer, byteOffset) {
        byteOffset = defaultValue(byteOffset, 0);

        var uint8Array = new Uint8Array(arrayBuffer);
        var magic = getMagic(uint8Array, byteOffset);
        if (magic !== 'pnts') {
            throw new DeveloperError('Invalid Points tile.  Expected magic=pnts.  Read magic=' + magic);
        }

        var view = new DataView(arrayBuffer);
        byteOffset += sizeOfUint32;  // Skip magic number

        var version = view.getUint32(byteOffset, true);
        if (version !== 1) {
            throw new DeveloperError('Only Points tile version 1 is supported.  Version ' + version + ' is not.');
        }
        //>>includeEnd('debug');
        byteOffset += sizeOfUint32;

        // Skip byteLength
        byteOffset += sizeOfUint32;

        var featureTableJSONByteLength = view.getUint32(byteOffset, true);
        //>>includeStart('debug', pragmas.debug);
        if (featureTableJSONByteLength === 0) {
            throw new DeveloperError('Feature table must have a byte length greater than zero');
        }
        //>>includeEnd('debug');
        byteOffset += sizeOfUint32;

        var featureTableBinaryByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;

        var featureTableString = getStringFromTypedArray(uint8Array, byteOffset, featureTableJSONByteLength);
        var featureTableJSON = JSON.parse(featureTableString);
        byteOffset += featureTableJSONByteLength;

        var featureTableBinary = new Uint8Array(arrayBuffer, byteOffset, featureTableBinaryByteLength);
        byteOffset += featureTableBinaryByteLength;

        var featureTableResources = new Cesium3DTileFeatureTableResources(featureTableJSON, featureTableBinary);
        var pointsLength = featureTableResources.getGlobalProperty('POINTS_LENGTH'); // TODO : use ComponentDatatype.UNSIGNED_INT
        featureTableResources.featuresLength = pointsLength;

        //>>includeStart('debug', pragmas.debug);
        if (!defined(pointsLength)) {
            throw new DeveloperError('Feature table global property: POINTS_LENGTH must be defined');
        }
        //>>includeEnd('debug');

        // Get the positions
        var positions;
        var isQuantized = false;

        if (defined(featureTableJSON.POSITION)) {
            positions = featureTableResources.getGlobalProperty('POSITION', ComponentDatatype.FLOAT, pointsLength * 3);
        } else if (defined(featureTableJSON.POSITION_QUANTIZED)) {
            positions = featureTableResources.getGlobalProperty('POSITION_QUANTIZED', ComponentDatatype.UNSIGNED_SHORT, pointsLength * 3);
            isQuantized = true;
            this._quantizedVolumeScale = featureTableResources.getGlobalProperty('QUANTIZED_VOLUME_SCALE', ComponentDatatype.FLOAT, 3);
            //>>includeStart('debug', pragmas.debug);
            if (!defined(this._quantizedVolumeScale)) {
                throw new DeveloperError('Global property: QUANTIZED_VOLUME_SCALE must be defined for quantized positions.');
            }
            //>>includeEnd('debug');
        }

        //>>includeStart('debug', pragmas.debug);
        if (!defined(positions)) {
            throw new DeveloperError('Either POSITION or POSITION_QUANTIZED must be defined.');
        }
        //>>includeEnd('debug');

        // Get the colors
        var colors;
        var isTranslucent = false;
        var isConstantColor = false;

        if (defined(featureTableJSON.RGBA)) {
            colors = featureTableResources.getGlobalProperty('RGBA', ComponentDatatype.UNSIGNED_BYTE, pointsLength * 4);
            isTranslucent = true;
        } else if (defined(featureTableJSON.RGB)) {
            colors = featureTableResources.getGlobalProperty('RGB', ComponentDatatype.UNISGNED_BYTE, pointsLength * 3);
        } else if (defined(featureTableJSON.CONSTANT_COLOR)) {
            var constantColor = featureTableResources.getGlobalProperty('CONSTANT_COLOR', ComponentDatatype.UNSIGNED_BYTE, 4);
            this._constantColor = Color.fromBytes(constantColor[0], constantColor[1], constantColor[2], constantColor[3], this._constantColor);
            isConstantColor = true;
            if (this._constantColor.alpha < 1.0) {
                isTranslucent = true;
            }
        }

        // Get the normals
        var normals;
        var isOctEncoded16P = false;

        if (defined(featureTableJSON.NORMAL)) {
            normals = featureTableResources.getGlobalProperty('NORMAL', ComponentDatatype.FLOAT, pointsLength * 3);
        } else if (defined(featureTableJSON.NORMAL_OCT16P)) {
            normals = featureTableResources.getGlobalProperty('NORMAL_OCT16P', ComponentDatatype.UNSIGNED_BYTE, pointsLength * 2);
            isOctEncoded16P = true;
        }

        // TODO : OCT32P not support by czm_octEncode?

        var hasColors = defined(colors);
        var hasNormals = defined(normals);

        if (!hasColors && !isConstantColor) {
            // Use a default constant color
            this._constantColor = Color.DARKGRAY;
        }

        var vs = 'attribute vec3 a_position; \n' +
                 'varying vec4 v_color; \n' +
                 'uniform float u_pointSize; \n' +
                 'uniform vec4 u_constantColor; \n';

        if (hasColors) {
            if (isTranslucent) {
                vs += 'attribute vec4 a_color; \n';
            } else {
                vs += 'attribute vec3 a_color; \n';
            }
        }
        if (hasNormals) {
            if (isOctEncoded16P) {
                vs += 'attribute vec2 a_normal; \n';
            } else {
                vs += 'attribute vec3 a_normal; \n';
            }
        }

        if (isQuantized) {
            vs += 'uniform vec3 u_quantizedVolumeScale; \n';
        }

        vs += 'void main() \n' +
              '{ \n';

        if (hasColors) {
            if (isTranslucent) {
                vs += '    vec4 color = a_color * u_constantColor; \n';
            } else {
                vs += '    vec4 color =  vec4(a_color * u_constantColor.rgb, u_constantColor.a); \n';
            }
        } else {
            vs += '    vec4 color = u_constantColor; \n';
        }

        if (hasNormals) {
            if (isOctEncoded16P) {
                vs += '    vec3 normal = czm_octDecode(a_normal); \n';
            } else {
                vs += '    vec3 normal = a_normal; \n';
            }

            vs += '    normal = czm_normal * normal; \n' +
                  '    color *= max(dot(normal, czm_sunDirectionEC), 0.0); \n';
        }

        if (isQuantized) {
            vs += '    vec3 position = a_position * u_quantizedVolumeScale; \n';
        } else {
            vs += '    vec3 position = a_position; \n';
        }

        vs += '    v_color = color; \n' +
              '    gl_Position = czm_modelViewProjection * vec4(position, 1.0); \n' +
              '    gl_PointSize = pointSize; \n' +
              '} \n';

        var fs = 'varying vec4 v_color; \n' +
                 'void main() \n' +
                 '{ \n' +
                 '    gl_FragColor = v_color; \n' +
                 '} \n';

        var that = this;
        var uniformMap = {
            u_pointSize : function() {
                return that._pointSize;
            },
            u_constantColor : function() {
                return that._constantColor;
            }
        };

        if (isQuantized) {
            uniformMap = combine(uniformMap, {
                u_quantizedVolumeScale : function() {
                    return that._quantizedVolumeScale;
                }
            });
        }

        var positionAttributeLocation = 0;
        var colorAttributeLocation = 1;
        var normalAttributeLocation = 2;

        var attributes = [];
        if (isQuantized) {
            attributes.push({
                index : positionAttributeLocation,
                vertexBuffer : positions,
                componentsPerAttribute : 3,
                componentDatatype : ComponentDatatype.UNSIGNED_SHORT,
                normalize : true, // Convert position to 0 to 1 before entering the shader
                offsetInBytes : 0,
                strideInBytes : 0
            });
        } else {
            attributes.push({
                index : positionAttributeLocation,
                vertexBuffer : positions,
                componentsPerAttribute : 3,
                componentDatatype : ComponentDatatype.FLOAT,
                normalize : false,
                offsetInBytes : 0,
                strideInBytes : 0
            });
        }

        if (hasColors) {
            var colorComponentsPerAttribute = isTranslucent ? 4 : 3;
            attributes.push({
                index : colorAttributeLocation,
                vertexBuffer : colors,
                componentsPerAttribute : colorComponentsPerAttribute,
                componentDatatype : ComponentDatatype.UNSIGNED_BYTE,
                normalize : true,
                offsetInBytes : 0,
                strideInBytes : 0
            });
        }

        if (hasNormals) {
            if (isOctEncoded16P) {
                attributes.push({
                    index : normalAttributeLocation,
                    vertexBuffer : normals,
                    componentsPerAttribute : 2,
                    componentDatatype : ComponentDatatype.UNSIGNED_BYTE,
                    normalize : false,
                    offsetInBytes : 0,
                    strideInBytes : 0
                });
            } else {
                attributes.push({
                    index : normalAttributeLocation,
                    vertexBuffer : normals,
                    componentsPerAttribute : 3,
                    componentDatatype : ComponentDatatype.FLOAT,
                    normalize : false,
                    offsetInBytes : 0,
                    strideInBytes : 0
                });
            }
        }

        var vertexArray = new VertexArray({
            context : context,
            attributes : attributes
        });

        var attributeLocations = {
            a_position : positionAttributeLocation
        };

        if (hasColors) {
            attributeLocations = combine(attributeLocations, {
                a_color : colorAttributeLocation
            });
        }

        if (hasNormals) {
            attributeLocations = combine(attributeLocations, {
                a_normal : normalAttributeLocation
            });
        }

        var shaderProgram = ShaderProgram.fromCache({
            context : context,
            vertexShaderSource : vs,
            fragmentShaderSource : fs,
            attributeLocations : attributeLocations
        });

        var rs = {
            depthTest : {
                enabled : true
            }
        };

        if (isTranslucent) {
            rs = combine(rs, {
                depthMask : false,
                blending : BlendingState.ALPHA_BLEND
            });
        }

        this._drawCommand = new DrawCommand({
            boundingVolume : this._tile.contentBoundingVolume.boundingSphere,
            cull : false, // Already culled by 3D tiles
            modelMatrix : new Matrix4(),
            primitiveType : PrimitiveType.POINTS,
            vertexArray : vertexArray,
            count : pointsLength,
            shaderProgram : shaderProgram,
            uniformMap : uniformMap,
            renderState : RenderState.fromCache(rs),
            pass : isTranslucent ? Pass.isTranslucent : Pass.OPAQUE,
            owner : this
        });

        this.state = Cesium3DTileContentState.PROCESSING;
        this.contentReadyToProcessPromise.resolve(this);


        // TODO : not ready until the update occurs and I actually have a context
        this.state = Cesium3DTileContentState.READY;
        this.readyPromise.resolve(this);

        // when(primitive.readyPromise).then(function(primitive) {
        //     that.state = Cesium3DTileContentState.READY;
        //     that.readyPromise.resolve(that);
        // }).otherwise(function(error) {
        //     that.state = Cesium3DTileContentState.FAILED;
        //     that.readyPromise.reject(error);
        // });
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Points3DTileContent.prototype.applyDebugSettings = function(enabled, color) {
        color = enabled ? color : this._constantColor;
        this._primitive.appearance.uniforms.constantColor = color;
    };


    var scratchMatrix = new Matrix3();

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Points3DTileContent.prototype.update = function(tileset, frameState) {
        // Update the model matrix
        var boundingSphere = this._tile.contentBoundingVolume.boundingSphere;
        var translation = boundingSphere.center;
        var rotation = Matrix4.getRotation(this._tile.computedTransform, scratchMatrix);
        Matrix4.fromRotationTranslation(rotation, translation, this._drawCommand.modelMatrix);
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Points3DTileContent.prototype.isDestroyed = function() {
        return false;
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Points3DTileContent.prototype.destroy = function() {
        this._primitive = this._primitive && this._primitive.destroy();
        return destroyObject(this);
    };

    return Points3DTileContent;
});
