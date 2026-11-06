//! Multi-band analysis in pixel space: line profiles (one sample per pixel
//! along a polyline, every band) and region statistics (per-band summary of
//! a pixel window).

use gdal::raster::ResampleAlg;
use gdal::Dataset;
use serde::Serialize;

/// Upper bound on profile samples; longer lines are sampled more sparsely
pub const MAX_PROFILE_SAMPLES: usize = 4096;
/// Profile bounding windows up to this many pixels are read in one call per
/// band; beyond that, each sample is read on its own
const PROFILE_WINDOW_BUDGET: usize = 16 * 1024 * 1024;
/// Pixels per band read for region statistics; larger regions are decimated
pub const REGION_SAMPLE_BUDGET: usize = 4 * 1024 * 1024;

/// A position along a polyline: pixel coordinates plus the segment it lies on
/// and how far along that segment (0..1)
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PolylineSample {
    pub x: f64,
    pub y: f64,
    pub segment: usize,
    pub fraction: f64,
    /// Distance from the start, in pixels
    pub along: f64,
}

/// Evenly spaced samples along a polyline in pixel space, about one per
/// pixel of length, at most `max_samples`. Both ends are included.
pub fn sample_polyline(
    vertices: &[(f64, f64)],
    max_samples: usize,
) -> Result<Vec<PolylineSample>, String> {
    if vertices.len() < 2 {
        return Err("A profile needs at least 2 points".to_string());
    }
    let lengths: Vec<f64> = vertices
        .windows(2)
        .map(|w| ((w[1].0 - w[0].0).powi(2) + (w[1].1 - w[0].1).powi(2)).sqrt())
        .collect();
    let total: f64 = lengths.iter().sum();
    if total.is_nan() || total <= 0.0 {
        return Err("Line has zero length".to_string());
    }

    let n = ((total.ceil() as usize) + 1).clamp(2, max_samples.max(2));
    let mut samples = Vec::with_capacity(n);
    let mut segment = 0;
    let mut segment_start = 0.0;
    for i in 0..n {
        let along = total * i as f64 / (n - 1) as f64;
        while segment + 1 < lengths.len() && segment_start + lengths[segment] < along {
            segment_start += lengths[segment];
            segment += 1;
        }
        let fraction = if lengths[segment] > 0.0 {
            ((along - segment_start) / lengths[segment]).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let (a, b) = (vertices[segment], vertices[segment + 1]);
        samples.push(PolylineSample {
            x: a.0 + (b.0 - a.0) * fraction,
            y: a.1 + (b.1 - a.1) * fraction,
            segment,
            fraction,
            along,
        });
    }
    Ok(samples)
}

fn valid(value: f64, nodata: Option<f64>) -> bool {
    value.is_finite() && nodata.is_none_or(|nd| (value - nd).abs() >= 1e-10)
}

/// Values of every band at integer pixel positions: `result[band][sample]`,
/// `None` outside the raster or for nodata.
pub fn read_band_values(
    dataset: &Dataset,
    pixels: &[(i64, i64)],
) -> Result<Vec<Vec<Option<f64>>>, String> {
    let (width, height) = dataset.raster_size();
    let inside = |&(x, y): &(i64, i64)| x >= 0 && y >= 0 && x < width as i64 && y < height as i64;

    // Bounding window of the in-raster samples
    let bbox = pixels.iter().filter(|p| inside(p)).fold(
        None,
        |acc: Option<(i64, i64, i64, i64)>, &(x, y)| {
            Some(match acc {
                None => (x, y, x, y),
                Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x), y1.max(y)),
            })
        },
    );

    let mut result = Vec::with_capacity(dataset.raster_count());
    for band_index in 1..=dataset.raster_count() {
        let band = dataset
            .rasterband(band_index)
            .map_err(|e| format!("Failed to get band {}: {}", band_index, e))?;
        let nodata = band.no_data_value();
        let mut values = vec![None; pixels.len()];

        if let Some((x0, y0, x1, y1)) = bbox {
            let (w, h) = ((x1 - x0 + 1) as usize, (y1 - y0 + 1) as usize);
            if w * h <= PROFILE_WINDOW_BUDGET {
                let buffer = band
                    .read_as::<f64>((x0 as isize, y0 as isize), (w, h), (w, h), None)
                    .map_err(|e| format!("Failed to read band {}: {}", band_index, e))?;
                let data = buffer.data();
                for (slot, p) in values.iter_mut().zip(pixels) {
                    if inside(p) {
                        let v = data[(p.1 - y0) as usize * w + (p.0 - x0) as usize];
                        *slot = valid(v, nodata).then_some(v);
                    }
                }
            } else {
                for (slot, p) in values.iter_mut().zip(pixels) {
                    if inside(p) {
                        let buffer = band
                            .read_as::<f64>((p.0 as isize, p.1 as isize), (1, 1), (1, 1), None)
                            .map_err(|e| format!("Failed to read band {}: {}", band_index, e))?;
                        let v = buffer.data()[0];
                        *slot = valid(v, nodata).then_some(v);
                    }
                }
            }
        }
        result.push(values);
    }
    Ok(result)
}

/// Summary of one band over a region
#[derive(Debug, Serialize, PartialEq)]
pub struct RegionBandStats {
    pub band: usize,
    /// Valid samples (after decimation)
    pub count: u64,
    pub nodata_count: u64,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub mean: Option<f64>,
    pub median: Option<f64>,
    pub sigma: Option<f64>,
    pub p2: Option<f64>,
    pub p98: Option<f64>,
    /// mean / sigma
    pub snr: Option<f64>,
}

/// Statistics of every band over a pixel window
#[derive(Debug, Serialize)]
pub struct RegionStatistics {
    /// Window in full-resolution pixels, clipped to the raster
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
    /// 1 when every pixel was read; n when one pixel in n×n was
    pub step: usize,
    pub bands: Vec<RegionBandStats>,
}

/// Value at quantile `q` of `values`, reordering them (nearest rank)
fn select_quantile(values: &mut [f32], q: f64) -> f64 {
    let k = ((values.len() - 1) as f64 * q).round() as usize;
    let (_, v, _) = values.select_nth_unstable_by(k, |a, b| a.total_cmp(b));
    f64::from(*v)
}

/// Summary of `samples`, skipping nodata and non-finite values
pub fn summarize(band: usize, samples: &[f64], nodata: Option<f64>) -> RegionBandStats {
    let mut kept: Vec<f32> = Vec::with_capacity(samples.len());
    let (mut sum, mut min, mut max) = (0.0f64, f64::INFINITY, f64::NEG_INFINITY);
    for &v in samples {
        if valid(v, nodata) {
            kept.push(v as f32);
            sum += v;
            min = min.min(v);
            max = max.max(v);
        }
    }
    let count = kept.len() as u64;
    let nodata_count = samples.len() as u64 - count;
    if kept.is_empty() {
        return RegionBandStats {
            band,
            count,
            nodata_count,
            min: None,
            max: None,
            mean: None,
            median: None,
            sigma: None,
            p2: None,
            p98: None,
            snr: None,
        };
    }
    let mean = sum / count as f64;
    // Second pass on the f64 input for a stable variance
    let var = samples
        .iter()
        .filter(|&&v| valid(v, nodata))
        .map(|&v| (v - mean).powi(2))
        .sum::<f64>()
        / count as f64;
    let sigma = var.sqrt();
    RegionBandStats {
        band,
        count,
        nodata_count,
        min: Some(min),
        max: Some(max),
        mean: Some(mean),
        median: Some(select_quantile(&mut kept, 0.5)),
        sigma: Some(sigma),
        p2: Some(select_quantile(&mut kept, 0.02)),
        p98: Some(select_quantile(&mut kept, 0.98)),
        snr: (sigma > 0.0).then(|| mean / sigma),
    }
}

/// Per-band statistics of the pixel window `[x0, x1) × [y0, y1)`, at least
/// one pixel, clipped to the raster. Windows over `REGION_SAMPLE_BUDGET` pixels are decimated
/// (nearest neighbour) to stay within it.
pub fn region_statistics(
    dataset: &Dataset,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
) -> Result<RegionStatistics, String> {
    let (width, height) = dataset.raster_size();
    // At least one pixel, so a click (zero-size box) reads the pixel under it
    let (lx, ty) = (x0.min(x1).floor(), y0.min(y1).floor());
    let (rx, by) = (
        x0.max(x1).ceil().max(lx + 1.0),
        y0.max(y1).ceil().max(ty + 1.0),
    );
    let clip = |v: f64, max: usize| v.clamp(0.0, max as f64) as usize;
    let (left, right) = (clip(lx, width), clip(rx, width));
    let (top, bottom) = (clip(ty, height), clip(by, height));
    let (w, h) = (right - left, bottom - top);
    if w == 0 || h == 0 {
        return Err("Region does not overlap the raster".to_string());
    }

    let step = ((w * h) as f64 / REGION_SAMPLE_BUDGET as f64)
        .sqrt()
        .ceil()
        .max(1.0) as usize;
    let (read_w, read_h) = (w.div_ceil(step), h.div_ceil(step));

    let mut bands = Vec::with_capacity(dataset.raster_count());
    for band_index in 1..=dataset.raster_count() {
        let band = dataset
            .rasterband(band_index)
            .map_err(|e| format!("Failed to get band {}: {}", band_index, e))?;
        let buffer = band
            .read_as::<f64>(
                (left as isize, top as isize),
                (w, h),
                (read_w, read_h),
                Some(ResampleAlg::NearestNeighbour),
            )
            .map_err(|e| format!("Failed to read band {}: {}", band_index, e))?;
        bands.push(summarize(band_index, buffer.data(), band.no_data_value()));
    }

    Ok(RegionStatistics {
        x: left,
        y: top,
        width: w,
        height: h,
        step,
        bands,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_dataset(w: usize, h: usize, bands: &[Vec<u16>]) -> Dataset {
        let driver = gdal::DriverManager::get_driver_by_name("MEM").unwrap();
        let ds = driver
            .create_with_band_type::<u16, _>("", w, h, bands.len())
            .unwrap();
        for (i, data) in bands.iter().enumerate() {
            let mut band = ds.rasterband(i + 1).unwrap();
            let mut buf = gdal::raster::Buffer::new((w, h), data.clone());
            band.write((0, 0), (w, h), &mut buf).unwrap();
        }
        ds
    }

    #[test]
    fn test_sample_polyline_one_per_pixel() {
        let s = sample_polyline(&[(0.0, 0.0), (10.0, 0.0)], 4096).unwrap();
        assert_eq!(s.len(), 11);
        assert_eq!((s[0].x, s[10].x), (0.0, 10.0));
        assert!((s[3].along - 3.0).abs() < 1e-9);
    }

    #[test]
    fn test_sample_polyline_segments_and_cap() {
        let s = sample_polyline(&[(0.0, 0.0), (4.0, 0.0), (4.0, 4.0)], 4096).unwrap();
        assert_eq!(s.len(), 9);
        assert_eq!((s[6].segment, s[6].x, s[6].y), (1, 4.0, 2.0));
        assert!((s[6].fraction - 0.5).abs() < 1e-9);

        let capped = sample_polyline(&[(0.0, 0.0), (10_000.0, 0.0)], 100).unwrap();
        assert_eq!(capped.len(), 100);
        assert_eq!(capped.last().unwrap().x, 10_000.0);
    }

    #[test]
    fn test_sample_polyline_rejects_degenerate() {
        assert!(sample_polyline(&[(1.0, 1.0)], 10).is_err());
        assert!(sample_polyline(&[(1.0, 1.0), (1.0, 1.0)], 10).is_err());
    }

    #[test]
    fn test_read_band_values_all_bands() {
        let a: Vec<u16> = (0..16).collect();
        let b: Vec<u16> = (0..16).map(|v| v * 10).collect();
        let ds = mem_dataset(4, 4, &[a, b]);
        ds.rasterband(2)
            .unwrap()
            .set_no_data_value(Some(50.0))
            .unwrap();
        let values = read_band_values(&ds, &[(1, 0), (1, 1), (9, 9)]).unwrap();
        assert_eq!(values[0], vec![Some(1.0), Some(5.0), None]);
        assert_eq!(values[1], vec![Some(10.0), None, None]);
    }

    #[test]
    fn test_summarize() {
        let s = summarize(1, &[1.0, 2.0, 3.0, 4.0, 5.0, 0.0], Some(0.0));
        assert_eq!((s.count, s.nodata_count), (5, 1));
        assert_eq!(
            (s.min, s.max, s.mean, s.median),
            (Some(1.0), Some(5.0), Some(3.0), Some(3.0))
        );
        assert!((s.sigma.unwrap() - 2f64.sqrt()).abs() < 1e-12);
        assert!((s.snr.unwrap() - 3.0 / 2f64.sqrt()).abs() < 1e-12);

        let empty = summarize(2, &[0.0, f64::NAN], Some(0.0));
        assert_eq!((empty.count, empty.mean, empty.snr), (0, None, None));
    }

    #[test]
    fn test_region_statistics_window() {
        let data: Vec<u16> = (0..100).collect();
        let ds = mem_dataset(10, 10, &[data]);
        // Columns 2..4, rows 1..3 → 12, 13, 22, 23
        let r = region_statistics(&ds, 4.0, 3.0, 2.0, 1.0).unwrap();
        assert_eq!((r.x, r.y, r.width, r.height, r.step), (2, 1, 2, 2, 1));
        assert_eq!(r.bands[0].mean, Some(17.5));
        assert_eq!((r.bands[0].min, r.bands[0].max), (Some(12.0), Some(23.0)));

        // Clipped to the raster
        let clipped = region_statistics(&ds, -5.0, -5.0, 2.0, 1.0).unwrap();
        assert_eq!(
            (clipped.x, clipped.y, clipped.width, clipped.height),
            (0, 0, 2, 1)
        );
        assert!(region_statistics(&ds, 20.0, 20.0, 30.0, 30.0).is_err());

        // A point reads the pixel under it
        let point = region_statistics(&ds, 3.0, 5.0, 3.0, 5.0).unwrap();
        assert_eq!((point.width, point.height), (1, 1));
        assert_eq!(point.bands[0].mean, Some(53.0));
    }
}
