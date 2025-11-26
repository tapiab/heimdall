/**
 * Test fixtures for geospatial tests
 */

// Sample point feature
export const samplePoint = {
  type: 'Feature',
  geometry: {
    type: 'Point',
    coordinates: [-122.4194, 37.7749],
  },
  properties: {
    name: 'San Francisco',
    population: 883305,
    state: 'CA',
  },
};

// Sample line feature
export const sampleLine = {
  type: 'Feature',
  geometry: {
    type: 'LineString',
    coordinates: [
      [-122.4194, 37.7749],
      [-122.4080, 37.7820],
      [-122.3920, 37.7900],
    ],
  },
  properties: {
    name: 'Route 1',
    length: 5.2,
  },
};

// Sample polygon feature
export const samplePolygon = {
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [[
      [-122.45, 37.75],
      [-122.40, 37.75],
      [-122.40, 37.80],
      [-122.45, 37.80],
      [-122.45, 37.75],
    ]],
  },
  properties: {
    name: 'Downtown Area',
    area: 25.5,
    type: 'urban',
  },
};

// Sample polygon with hole
export const samplePolygonWithHole = {
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [[-122.50, 37.70], [-122.35, 37.70], [-122.35, 37.85], [-122.50, 37.85], [-122.50, 37.70]],
      [[-122.45, 37.75], [-122.40, 37.75], [-122.40, 37.80], [-122.45, 37.80], [-122.45, 37.75]],
    ],
  },
  properties: {
    name: 'Park with Lake',
    type: 'recreation',
  },
};

// Sample multipoint feature
export const sampleMultiPoint = {
  type: 'Feature',
  geometry: {
    type: 'MultiPoint',
    coordinates: [
      [-122.4194, 37.7749],
      [-122.4100, 37.7800],
      [-122.4000, 37.7850],
    ],
  },
  properties: {
    name: 'Stations',
    count: 3,
  },
};

// Sample multipolygon feature
export const sampleMultiPolygon = {
  type: 'Feature',
  geometry: {
    type: 'MultiPolygon',
    coordinates: [
      [[[-122.50, 37.70], [-122.45, 37.70], [-122.45, 37.75], [-122.50, 37.75], [-122.50, 37.70]]],
      [[[-122.40, 37.80], [-122.35, 37.80], [-122.35, 37.85], [-122.40, 37.85], [-122.40, 37.80]]],
    ],
  },
  properties: {
    name: 'Islands',
    islandCount: 2,
  },
};

// Sample feature collection
export const sampleFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.4194, 37.7749] },
      properties: { id: 1, name: 'Point A', value: 100, category: 'A' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.4100, 37.7800] },
      properties: { id: 2, name: 'Point B', value: 200, category: 'B' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.4000, 37.7850] },
      properties: { id: 3, name: 'Point C', value: 150, category: 'A' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.3900, 37.7900] },
      properties: { id: 4, name: 'Point D', value: 300, category: 'C' },
    },
  ],
};

// Sample features with null/missing properties
export const sampleFeaturesWithNulls = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { name: 'Complete', value: 100 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 1] },
      properties: { name: null, value: 200 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [2, 2] },
      properties: { name: 'Partial' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [3, 3] },
      properties: {},
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [4, 4] },
      properties: null,
    },
  ],
};

// Sample raster layer metadata (simulated)
export const sampleRasterMetadata = {
  id: 'test-raster-123',
  path: '/path/to/test.tif',
  width: 1024,
  height: 768,
  bands: 3,
  bounds: [-122.5, 37.7, -122.3, 37.9],
  band_stats: [
    { min: 0, max: 255, mean: 128.5, std_dev: 45.2 },
    { min: 0, max: 255, mean: 120.3, std_dev: 42.8 },
    { min: 0, max: 255, mean: 135.1, std_dev: 48.1 },
  ],
  crs: 'EPSG:4326',
  is_georeferenced: true,
};

// Sample single-band raster metadata
export const sampleSingleBandRasterMetadata = {
  id: 'test-dem-456',
  path: '/path/to/elevation.tif',
  width: 512,
  height: 512,
  bands: 1,
  bounds: [-122.5, 37.7, -122.3, 37.9],
  band_stats: [
    { min: -50, max: 1500, mean: 425.3, std_dev: 312.7 },
  ],
  crs: 'EPSG:4326',
  is_georeferenced: true,
};

// Sample non-georeferenced image metadata
export const sampleNonGeoImageMetadata = {
  id: 'test-image-789',
  path: '/path/to/photo.png',
  width: 800,
  height: 600,
  bands: 4,
  bounds: [0, 0, 800, 600],
  band_stats: [
    { min: 0, max: 255, mean: 128.0, std_dev: 64.0 },
    { min: 0, max: 255, mean: 128.0, std_dev: 64.0 },
    { min: 0, max: 255, mean: 128.0, std_dev: 64.0 },
    { min: 0, max: 255, mean: 255.0, std_dev: 0.0 },
  ],
  crs: null,
  is_georeferenced: false,
};

// Sample vector layer metadata
export const sampleVectorMetadata = {
  id: 'test-vector-abc',
  path: '/path/to/boundaries.geojson',
  bounds: [-122.5, 37.7, -122.3, 37.9],
  feature_count: 42,
  geometry_type: 'Polygon',
  fields: [
    { name: 'id', type: 'Integer' },
    { name: 'name', type: 'String' },
    { name: 'area', type: 'Real' },
    { name: 'category', type: 'String' },
  ],
};

// Sample bounds for intersection tests
export const sampleBounds = {
  sanFrancisco: [-122.5149, 37.7081, -122.3550, 37.8324],
  oakland: [-122.3550, 37.7081, -122.1149, 37.8850],
  pacific: [-140.0, 30.0, -130.0, 40.0],
  world: [-180, -90, 180, 90],
};
