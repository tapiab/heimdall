/**
 * Colormaps for single-band rasters, as 256-entry RGB lookup tables.
 * @module layer-manager/colormaps
 */

export const COLORMAPS = [
  'gray',
  'viridis',
  'magma',
  'inferno',
  'plasma',
  'turbo',
  'rdbu',
  'terrain',
] as const;

export type ColormapName = (typeof COLORMAPS)[number];

export const COLORMAP_LABELS: Record<ColormapName, string> = {
  gray: 'Gray',
  viridis: 'Viridis',
  magma: 'Magma',
  inferno: 'Inferno',
  plasma: 'Plasma',
  turbo: 'Turbo',
  rdbu: 'Red-Blue (diverging)',
  terrain: 'Terrain',
};

type Rgb = [number, number, number];

/**
 * Polynomial fits (degree 6) of the matplotlib perceptual colormaps, from
 * Matt Zucker's "Colormap approximations" (shadertoy WlfXRN). Coefficients
 * c0..c6 per channel; error is below one 8-bit step almost everywhere.
 */
const POLY: Record<'viridis' | 'magma' | 'inferno' | 'plasma', Rgb[]> = {
  viridis: [
    [0.2777273272234177, 0.005407344544966578, 0.3340998053353061],
    [0.1050930431085774, 1.404613529898575, 1.384590162594685],
    [-0.3308618287255563, 0.214847559468213, 0.09509516302823659],
    [-4.634230498983486, -5.799100973351585, -19.33244095627987],
    [6.228269936347081, 14.17993336680509, 56.69055260068105],
    [4.776384997670288, -13.74514537774601, -65.35303263337234],
    [-5.435455855934631, 4.645852612178535, 26.3124352495832],
  ],
  plasma: [
    [0.05873234392399702, 0.02333670892565664, 0.5433401826748754],
    [2.176514634195958, 0.2383834171260182, 0.7539604599784036],
    [-2.689460476458034, -7.455851135738909, 3.110799939717086],
    [6.130348345893603, 42.3461881477227, -28.51885465332158],
    [-11.10743619062271, -82.66631109428045, 60.13984767418263],
    [10.02306557647065, 71.41361770095349, -54.07218655560067],
    [-3.658713842777788, -22.93153465461149, 18.19190778539828],
  ],
  magma: [
    [-0.002136485053939582, -0.000749655052795221, -0.005386127855323933],
    [0.2516605407371642, 0.6775232436837668, 2.494026599312351],
    [8.353717279216625, -3.577719514958484, 0.3144679030132573],
    [-27.66873308576866, 14.26473078096533, -13.64921318813922],
    [52.17613981234068, -27.94360607168351, 12.94416944238394],
    [-50.76852536473588, 29.04658282127291, 4.23415299384598],
    [18.65570506591883, -11.48977351997711, -5.601961508734096],
  ],
  inferno: [
    [0.0002189403691192265, 0.001651004631001012, -0.01948089843709184],
    [0.1065134194856116, 0.5639564367884091, 3.932712388889277],
    [11.60249308247187, -3.972853965665698, -15.9423941062914],
    [-41.70399613139459, 17.43639888205313, 44.35414519872813],
    [77.162935699427, -33.40235894210092, -81.80730925738993],
    [-71.31942824499214, 32.62606426397723, 73.20951985803202],
    [25.13112622477341, -12.24266895238567, -23.07032500287172],
  ],
};

/** Google's polynomial approximation of Turbo (degree 5). */
const TURBO: Rgb[] = [
  [0.13572138, 0.09140261, 0.1066733],
  [4.6153926, 2.19418839, 12.64194608],
  [-42.66032258, 4.84296658, -60.58204836],
  [132.13108234, -14.18503333, 110.36276771],
  [-152.94239396, 4.27729857, -89.90310912],
  [59.28637943, 2.82956604, 27.34824973],
];

/** Piecewise-linear colormaps: [position, r, g, b] with channels in 0..1. */
const STOPS: Record<'rdbu' | 'terrain', Array<[number, number, number, number]>> = {
  // ColorBrewer RdBu (11 classes): red at the low end, blue at the high end.
  rdbu: [
    '67001f',
    'b2182b',
    'd6604d',
    'f4a582',
    'fddbc7',
    'f7f7f7',
    'd1e5f0',
    '92c5de',
    '4393c3',
    '2166ac',
    '053061',
  ].map((hex, i, all) => [
    i / (all.length - 1),
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  ]),
  // matplotlib "terrain": deep water, shallows, lowland, highland, rock, snow.
  terrain: [
    [0.0, 0.2, 0.2, 0.6],
    [0.15, 0.0, 0.6, 1.0],
    [0.25, 0.0, 0.8, 0.4],
    [0.5, 1.0, 1.0, 0.6],
    [0.75, 0.5, 0.36, 0.33],
    [1.0, 1.0, 1.0, 1.0],
  ],
};

function polynomial(coeffs: Rgb[], t: number): Rgb {
  const out: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let v = 0;
    for (let k = coeffs.length - 1; k >= 0; k--) v = v * t + coeffs[k][c];
    out[c] = v;
  }
  return out;
}

function piecewise(stops: Array<[number, number, number, number]>, t: number): Rgb {
  let i = 1;
  while (i < stops.length - 1 && t > stops[i][0]) i++;
  const [p0, r0, g0, b0] = stops[i - 1];
  const [p1, r1, g1, b1] = stops[i];
  const f = p1 > p0 ? (t - p0) / (p1 - p0) : 0;
  return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
}

/** Color at `t` in 0..1, channels in 0..1 (unclamped). */
function sample(name: ColormapName, t: number): Rgb {
  switch (name) {
    case 'gray':
      return [t, t, t];
    case 'turbo':
      return polynomial(TURBO, t);
    case 'rdbu':
    case 'terrain':
      return piecewise(STOPS[name], t);
    default:
      return polynomial(POLY[name], t);
  }
}

const luts = new Map<ColormapName, Uint8Array>();

/**
 * 256-entry RGB lookup table (768 bytes, r,g,b interleaved). Entry `i` is the
 * color for a stretched value of `i`; gray is the identity.
 */
export function getColormapLut(name: ColormapName): Uint8Array {
  let lut = luts.get(name);
  if (!lut) {
    lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const rgb = sample(name, i / 255);
      for (let c = 0; c < 3; c++) {
        lut[i * 3 + c] = Math.round(Math.min(1, Math.max(0, rgb[c])) * 255);
      }
    }
    luts.set(name, lut);
  }
  return lut;
}

/** Whether `value` names a known colormap (e.g. from a saved project). */
export function isColormapName(value: unknown): value is ColormapName {
  return typeof value === 'string' && (COLORMAPS as readonly string[]).includes(value);
}

/** CSS linear-gradient preview of a colormap. */
export function colormapGradient(name: ColormapName): string {
  const lut = getColormapLut(name);
  const stops: string[] = [];
  for (let i = 0; i <= 8; i++) {
    const k = Math.round((i / 8) * 255) * 3;
    stops.push(`rgb(${lut[k]}, ${lut[k + 1]}, ${lut[k + 2]}) ${(i / 8) * 100}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
