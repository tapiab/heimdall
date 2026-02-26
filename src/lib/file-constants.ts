/** Supported vector file extensions */
export const VECTOR_EXTENSIONS = [
  'shp',
  'geojson',
  'json',
  'gpkg',
  'kml',
  'kmz',
  'gml',
  'gpx',
  'fgb',
  'tab',
  'mif',
];

/** Supported raster file extensions (GDAL supported) */
export const RASTER_EXTENSIONS = [
  'tif',
  'tiff',
  'geotiff',
  'img',
  'vrt',
  'ntf',
  'nitf',
  'dt0',
  'dt1',
  'dt2',
  'hgt',
  'ers',
  'ecw',
  'jp2',
  'j2k',
  'sid',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'hdr',
  'bil',
  'bsq',
  'bip',
  'grd',
  'asc',
  'dem',
  'nc',
  'hdf',
  'h5',
];

/** All supported geospatial file extensions */
export const ALL_EXTENSIONS = [...RASTER_EXTENSIONS, ...VECTOR_EXTENSIONS];
