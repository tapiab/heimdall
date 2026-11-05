//! Whole-band statistics for sensor QA: global summary plus per-column and
//! per-line series (median, mean, sigma), which expose striping, dead or hot
//! columns, and line-to-line noise.

use gdal::raster::RasterBand;
use serde::{Deserialize, Serialize};

/// Samples read per GDAL call (rows × width)
const READ_BLOCK_SAMPLES: usize = 4 * 1024 * 1024;
/// Samples kept to compute column and global medians
const MEDIAN_SAMPLE_BUDGET: usize = 16 * 1024 * 1024;
/// Samples per line used for that line's median
const LINE_MEDIAN_SAMPLES: usize = 8192;

/// Percentiles of a band sample, for contrast stretch presets
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Percentiles {
    pub p1: f64,
    pub p2: f64,
    pub p98: f64,
    pub p99: f64,
}

/// One statistic per column or per line; `None` where every sample is nodata
#[derive(Debug, Serialize)]
pub struct AxisSeries {
    pub median: Vec<Option<f32>>,
    pub mean: Vec<Option<f32>>,
    pub sigma: Vec<Option<f32>>,
}

#[derive(Debug, Serialize)]
pub struct ImageStatistics {
    pub band: usize,
    pub width: usize,
    pub height: usize,
    /// Valid samples (not nodata, finite)
    pub count: u64,
    pub nodata_count: u64,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub mean: Option<f64>,
    /// Median of the sampled lines (exact when `median_lines == height`)
    pub median: Option<f64>,
    pub sigma: Option<f64>,
    /// mean / sigma
    pub snr: Option<f64>,
    pub columns: AxisSeries,
    pub lines: AxisSeries,
    /// Lines used for column and global medians (means and sigmas use all)
    pub median_lines: usize,
}

fn valid(value: f64, nodata: Option<f64>) -> bool {
    value.is_finite() && nodata.is_none_or(|nd| (value - nd).abs() >= 1e-10)
}

/// Median of `values`, reordering them. `None` when empty.
fn median_in_place(values: &mut [f32]) -> Option<f32> {
    if values.is_empty() {
        return None;
    }
    let mid = values.len() / 2;
    let (_, &mut upper, _) = values.select_nth_unstable_by(mid, f32::total_cmp);
    if values.len() % 2 == 1 {
        return Some(upper);
    }
    let lower = values[..mid].iter().copied().fold(f32::MIN, f32::max);
    Some((lower + upper) / 2.0)
}

/// Value at quantile `q` (0..=1) of sorted `values`, nearest rank.
fn quantile_sorted(sorted: &[f64], q: f64) -> f64 {
    let rank = (q * (sorted.len() - 1) as f64).round() as usize;
    sorted[rank.min(sorted.len() - 1)]
}

/// 1st, 2nd, 98th and 99th percentiles of the valid samples, or `None`.
pub fn percentiles(values: &[f64], nodata: Option<f64>) -> Option<Percentiles> {
    let mut sorted: Vec<f64> = values
        .iter()
        .copied()
        .filter(|&v| valid(v, nodata))
        .collect();
    if sorted.is_empty() {
        return None;
    }
    sorted.sort_unstable_by(f64::total_cmp);
    Some(Percentiles {
        p1: quantile_sorted(&sorted, 0.01),
        p2: quantile_sorted(&sorted, 0.02),
        p98: quantile_sorted(&sorted, 0.98),
        p99: quantile_sorted(&sorted, 0.99),
    })
}

/// Running sums for mean and sigma
#[derive(Clone, Copy, Default)]
struct Moments {
    count: u64,
    sum: f64,
    sum_sq: f64,
}

impl Moments {
    fn add(&mut self, v: f64) {
        self.count += 1;
        self.sum += v;
        self.sum_sq += v * v;
    }

    fn mean(&self) -> Option<f64> {
        (self.count > 0).then(|| self.sum / self.count as f64)
    }

    /// Population standard deviation
    fn sigma(&self) -> Option<f64> {
        let mean = self.mean()?;
        Some(
            (self.sum_sq / self.count as f64 - mean * mean)
                .max(0.0)
                .sqrt(),
        )
    }
}

/// Accumulates statistics over lines fed in order.
pub struct StatsAccumulator {
    width: usize,
    height: usize,
    nodata: Option<f64>,
    /// Every `median_stride`-th line is kept for column and global medians
    median_stride: usize,
    total: Moments,
    nodata_count: u64,
    min: f64,
    max: f64,
    columns: Vec<Moments>,
    /// Kept lines, row-major, NaN for nodata
    median_rows: Vec<f32>,
    median_lines: usize,
    lines: AxisSeries,
    line_buf: Vec<f32>,
}

impl StatsAccumulator {
    pub fn new(width: usize, height: usize, nodata: Option<f64>) -> Self {
        let kept_lines = (MEDIAN_SAMPLE_BUDGET / width.max(1)).clamp(1, height.max(1));
        Self {
            width,
            height,
            nodata,
            median_stride: height.max(1).div_ceil(kept_lines),
            total: Moments::default(),
            nodata_count: 0,
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
            columns: vec![Moments::default(); width],
            median_rows: Vec::new(),
            median_lines: 0,
            lines: AxisSeries {
                median: Vec::with_capacity(height),
                mean: Vec::with_capacity(height),
                sigma: Vec::with_capacity(height),
            },
            line_buf: Vec::with_capacity(width),
        }
    }

    /// Add line number `row` (lines must arrive in order, all `width` samples).
    pub fn add_line(&mut self, row: usize, samples: &[f64]) {
        debug_assert_eq!(samples.len(), self.width);
        let keep = row.is_multiple_of(self.median_stride);
        let line_step = self.width.div_ceil(LINE_MEDIAN_SAMPLES).max(1);
        let mut line = Moments::default();
        self.line_buf.clear();

        for (col, &v) in samples.iter().enumerate() {
            if !valid(v, self.nodata) {
                self.nodata_count += 1;
                if keep {
                    self.median_rows.push(f32::NAN);
                }
                continue;
            }
            self.total.add(v);
            self.columns[col].add(v);
            line.add(v);
            self.min = self.min.min(v);
            self.max = self.max.max(v);
            if col % line_step == 0 {
                self.line_buf.push(v as f32);
            }
            if keep {
                self.median_rows.push(v as f32);
            }
        }
        if keep {
            self.median_lines += 1;
        }

        self.lines.median.push(median_in_place(&mut self.line_buf));
        self.lines.mean.push(line.mean().map(|m| m as f32));
        self.lines.sigma.push(line.sigma().map(|s| s as f32));
    }

    pub fn finish(self, band: usize) -> ImageStatistics {
        let width = self.width;
        let mut column_values = Vec::with_capacity(self.median_lines);
        let column_median = (0..width)
            .map(|col| {
                column_values.clear();
                column_values.extend(
                    self.median_rows
                        .iter()
                        .skip(col)
                        .step_by(width.max(1))
                        .copied()
                        .filter(|v| !v.is_nan()),
                );
                median_in_place(&mut column_values)
            })
            .collect();

        let mut all: Vec<f32> = self
            .median_rows
            .into_iter()
            .filter(|v| !v.is_nan())
            .collect();
        let median = median_in_place(&mut all).map(f64::from);
        let mean = self.total.mean();
        let sigma = self.total.sigma();
        let has_data = self.total.count > 0;

        ImageStatistics {
            band,
            width,
            height: self.height,
            count: self.total.count,
            nodata_count: self.nodata_count,
            min: has_data.then_some(self.min),
            max: has_data.then_some(self.max),
            mean,
            median,
            sigma,
            snr: match (mean, sigma) {
                (Some(m), Some(s)) if s > 0.0 => Some(m / s),
                _ => None,
            },
            columns: AxisSeries {
                median: column_median,
                mean: self
                    .columns
                    .iter()
                    .map(|c| c.mean().map(|m| m as f32))
                    .collect(),
                sigma: self
                    .columns
                    .iter()
                    .map(|c| c.sigma().map(|s| s as f32))
                    .collect(),
            },
            lines: self.lines,
            median_lines: self.median_lines,
        }
    }
}

/// Read a whole band at full resolution, block by block, and summarize it.
/// Samples equal to the band's nodata, or non-finite, are excluded.
pub fn compute_image_statistics(
    band: &RasterBand,
    band_index: usize,
) -> Result<ImageStatistics, String> {
    let (width, height) = band.size();
    let nodata = band.no_data_value();
    let mut acc = StatsAccumulator::new(width, height, nodata);
    let block_rows = (READ_BLOCK_SAMPLES / width.max(1)).max(1);

    let mut row = 0;
    while row < height {
        let rows = block_rows.min(height - row);
        let buffer = band
            .read_as::<f64>((0, row as isize), (width, rows), (width, rows), None)
            .map_err(|e| format!("Failed to read rows {}..{}: {}", row, row + rows, e))?;
        for (i, line) in buffer.data().chunks_exact(width).enumerate() {
            acc.add_line(row + i, line);
        }
        row += rows;
    }
    Ok(acc.finish(band_index))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats_of(
        width: usize,
        height: usize,
        nodata: Option<f64>,
        f: impl Fn(usize, usize) -> f64,
    ) -> ImageStatistics {
        let mut acc = StatsAccumulator::new(width, height, nodata);
        for row in 0..height {
            let line: Vec<f64> = (0..width).map(|col| f(col, row)).collect();
            acc.add_line(row, &line);
        }
        acc.finish(1)
    }

    #[test]
    fn test_median_in_place() {
        assert_eq!(median_in_place(&mut []), None);
        assert_eq!(median_in_place(&mut [3.0, 1.0, 2.0]), Some(2.0));
        assert_eq!(median_in_place(&mut [4.0, 1.0, 3.0, 2.0]), Some(2.5));
    }

    #[test]
    fn test_percentiles_skip_nodata() {
        let mut values: Vec<f64> = (1..=100).map(f64::from).collect();
        values.extend([-9999.0; 50]);
        values.push(f64::NAN);
        let p = percentiles(&values, Some(-9999.0)).unwrap();
        assert_eq!(p.p1, 2.0);
        assert_eq!(p.p2, 3.0);
        assert_eq!(p.p98, 98.0);
        assert_eq!(p.p99, 99.0);
        assert_eq!(percentiles(&[-9999.0], Some(-9999.0)), None);
    }

    #[test]
    fn test_global_summary() {
        // 0..9 repeated on every line
        let s = stats_of(10, 4, None, |col, _| col as f64);
        assert_eq!(s.count, 40);
        assert_eq!(s.min, Some(0.0));
        assert_eq!(s.max, Some(9.0));
        assert_eq!(s.mean, Some(4.5));
        assert_eq!(s.median, Some(4.5));
        let sigma = s.sigma.unwrap();
        assert!((sigma - 8.25_f64.sqrt()).abs() < 1e-9);
        assert!((s.snr.unwrap() - 4.5 / sigma).abs() < 1e-9);
    }

    #[test]
    fn test_hot_column_and_noisy_line() {
        // Flat 100, column 3 stuck at 4000, line 2 alternates 50/150.
        let s = stats_of(8, 5, None, |col, row| match (col, row) {
            (3, _) => 4000.0,
            (c, 2) if c % 2 == 0 => 50.0,
            (_, 2) => 150.0,
            _ => 100.0,
        });
        assert_eq!(s.columns.median[3], Some(4000.0));
        assert_eq!(s.columns.median[0], Some(100.0));
        assert_eq!(s.columns.sigma[3], Some(0.0));
        assert_eq!(s.lines.sigma[0], s.lines.sigma[1]);
        assert!(s.lines.sigma[2].unwrap() > s.lines.sigma[0].unwrap());
        assert_eq!(s.columns.median.len(), 8);
        assert_eq!(s.lines.median.len(), 5);
    }

    #[test]
    fn test_nodata_excluded() {
        let s = stats_of(4, 2, Some(0.0), |col, row| {
            if col == 0 || row == 1 {
                0.0
            } else {
                7.0
            }
        });
        assert_eq!(s.count, 3);
        assert_eq!(s.nodata_count, 5);
        assert_eq!(s.columns.mean[0], None);
        assert_eq!(s.columns.mean[1], Some(7.0));
        assert_eq!(s.lines.median[1], None);
        assert_eq!(s.mean, Some(7.0));
    }

    #[test]
    fn test_all_nodata() {
        let s = stats_of(3, 3, Some(1.0), |_, _| 1.0);
        assert_eq!(s.count, 0);
        assert_eq!(
            (s.min, s.max, s.mean, s.median, s.snr),
            (None, None, None, None, None)
        );
    }

    #[test]
    fn test_compute_from_gdal_band() {
        let driver = gdal::DriverManager::get_driver_by_name("MEM").unwrap();
        let ds = driver.create_with_band_type::<u16, _>("", 6, 3, 1).unwrap();
        let mut band = ds.rasterband(1).unwrap();
        let data: Vec<u16> = (0..18).map(|i| (i % 6) as u16 * 10).collect();
        let mut buf = gdal::raster::Buffer::new((6, 3), data);
        band.write((0, 0), (6, 3), &mut buf).unwrap();
        let s = compute_image_statistics(&band, 1).unwrap();
        assert_eq!((s.width, s.height, s.count), (6, 3, 18));
        assert_eq!(s.columns.median[5], Some(50.0));
        assert_eq!(s.median_lines, 3);
    }

    /// Timing on a 10000x10000 u16 band: `cargo test --release -- --ignored bench_image_statistics --nocapture`
    #[test]
    #[ignore]
    fn bench_image_statistics() {
        let (w, h) = (10_000, 10_000);
        let driver = gdal::DriverManager::get_driver_by_name("MEM").unwrap();
        let ds = driver.create_with_band_type::<u16, _>("", w, h, 1).unwrap();
        let mut band = ds.rasterband(1).unwrap();
        let data: Vec<u16> = (0..w * h).map(|i| ((i * 7919) % 4096) as u16).collect();
        let mut buf = gdal::raster::Buffer::new((w, h), data);
        band.write((0, 0), (w, h), &mut buf).unwrap();
        let start = std::time::Instant::now();
        let s = compute_image_statistics(&band, 1).unwrap();
        println!(
            "100 Mpx: {:?}, median_lines={}",
            start.elapsed(),
            s.median_lines
        );
    }
}
