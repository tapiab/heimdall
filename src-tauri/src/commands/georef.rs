//! Georeferencing commands for manual GCP-based image georeferencing
//!
//! Supports polynomial transformations (1st, 2nd, 3rd order) and thin plate spline (TPS).

use gdal::cpl::CslStringList;
use gdal::spatial_ref::SpatialRef;
use gdal::{Dataset, Driver, DriverManager};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{AppHandle, Emitter};

/// Ground Control Point data from frontend
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GCPData {
    pub pixel_x: f64,
    pub pixel_y: f64,
    pub geo_x: f64,
    pub geo_y: f64,
}

/// Result of transformation calculation
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TransformResult {
    pub success: bool,
    pub rms_error: Option<f64>,
    pub residuals: Option<Vec<f64>>,
    pub forward_transform: Option<Vec<f64>>, // Coefficients for pixel -> geo
    pub error: Option<String>,
}

/// Result of applying georeferencing
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GeoreferenceResult {
    pub success: bool,
    pub output_path: Option<String>,
    pub error: Option<String>,
}

/// Progress event payload
#[derive(Clone, Debug, Serialize)]
pub struct GeoreferenceProgress {
    pub stage: String,
    pub progress: f32, // 0.0 to 1.0
    pub message: String,
}

/// Helper to emit progress events
fn emit_progress(app: &AppHandle, stage: &str, progress: f32, message: &str) {
    let _ = app.emit(
        "georef-progress",
        GeoreferenceProgress {
            stage: stage.to_string(),
            progress,
            message: message.to_string(),
        },
    );
}

/// Minimum GCPs required for each transformation type
fn min_gcps_for_transform(transform_type: &str) -> usize {
    match transform_type {
        "polynomial1" => 3,
        "polynomial2" => 6,
        "polynomial3" => 10,
        "tps" => 3,
        _ => 3,
    }
}

/// Solve affine transformation (polynomial order 1) using least squares
/// Returns coefficients [a0, a1, a2, b0, b1, b2] where:
///   geo_x = a0 + a1*pixel_x + a2*pixel_y
///   geo_y = b0 + b1*pixel_x + b2*pixel_y
fn solve_affine(gcps: &[GCPData]) -> Result<Vec<f64>, String> {
    let n = gcps.len();
    if n < 3 {
        return Err("Minimum 3 GCPs required for affine transformation".to_string());
    }

    // Build design matrix A and observation vectors
    // A = [1, x1, y1]
    //     [1, x2, y2]
    //     ...
    // We solve: A * coeffs = observations using normal equations
    // (A^T * A) * coeffs = A^T * observations

    // For 3 GCPs, we have exact solution. For more, least squares.
    let mut ata = [[0.0f64; 3]; 3]; // A^T * A
    let mut atb_x = [0.0f64; 3]; // A^T * geo_x
    let mut atb_y = [0.0f64; 3]; // A^T * geo_y

    for gcp in gcps {
        let row = [1.0, gcp.pixel_x, gcp.pixel_y];

        // A^T * A
        for i in 0..3 {
            for j in 0..3 {
                ata[i][j] += row[i] * row[j];
            }
        }

        // A^T * b
        for i in 0..3 {
            atb_x[i] += row[i] * gcp.geo_x;
            atb_y[i] += row[i] * gcp.geo_y;
        }
    }

    // Solve using Gaussian elimination (3x3 system)
    let coeffs_x = solve_3x3(&ata, &atb_x)?;
    let coeffs_y = solve_3x3(&ata, &atb_y)?;

    Ok(vec![
        coeffs_x[0],
        coeffs_x[1],
        coeffs_x[2],
        coeffs_y[0],
        coeffs_y[1],
        coeffs_y[2],
    ])
}

/// Solve 3x3 linear system using Gaussian elimination with partial pivoting
fn solve_3x3(a: &[[f64; 3]; 3], b: &[f64; 3]) -> Result<[f64; 3], String> {
    let mut aug = [[0.0f64; 4]; 3];

    // Create augmented matrix
    for i in 0..3 {
        for j in 0..3 {
            aug[i][j] = a[i][j];
        }
        aug[i][3] = b[i];
    }

    // Forward elimination with partial pivoting
    for col in 0..3 {
        // Find pivot
        let mut max_row = col;
        for row in (col + 1)..3 {
            if aug[row][col].abs() > aug[max_row][col].abs() {
                max_row = row;
            }
        }

        // Swap rows
        if max_row != col {
            aug.swap(col, max_row);
        }

        // Check for singular matrix
        if aug[col][col].abs() < 1e-12 {
            return Err("Singular matrix - GCPs may be collinear".to_string());
        }

        // Eliminate
        for row in (col + 1)..3 {
            let factor = aug[row][col] / aug[col][col];
            for j in col..4 {
                aug[row][j] -= factor * aug[col][j];
            }
        }
    }

    // Back substitution
    let mut result = [0.0f64; 3];
    for i in (0..3).rev() {
        result[i] = aug[i][3];
        for j in (i + 1)..3 {
            result[i] -= aug[i][j] * result[j];
        }
        result[i] /= aug[i][i];
    }

    Ok(result)
}

/// Solve polynomial order 2 transformation
/// geo_x = a0 + a1*x + a2*y + a3*x^2 + a4*x*y + a5*y^2
/// geo_y = b0 + b1*x + b2*y + b3*x^2 + b4*x*y + b5*y^2
/// Requires 6+ GCPs
fn solve_polynomial2(gcps: &[GCPData]) -> Result<Vec<f64>, String> {
    let n = gcps.len();
    if n < 6 {
        return Err("Minimum 6 GCPs required for 2nd order polynomial".to_string());
    }

    // 6 coefficients per equation
    let num_coeffs = 6;
    let mut ata = vec![vec![0.0f64; num_coeffs]; num_coeffs];
    let mut atb_x = vec![0.0f64; num_coeffs];
    let mut atb_y = vec![0.0f64; num_coeffs];

    for gcp in gcps {
        let x = gcp.pixel_x;
        let y = gcp.pixel_y;
        let row = [1.0, x, y, x * x, x * y, y * y];

        for i in 0..num_coeffs {
            for j in 0..num_coeffs {
                ata[i][j] += row[i] * row[j];
            }
            atb_x[i] += row[i] * gcp.geo_x;
            atb_y[i] += row[i] * gcp.geo_y;
        }
    }

    let coeffs_x = solve_nxn(&ata, &atb_x)?;
    let coeffs_y = solve_nxn(&ata, &atb_y)?;

    let mut result = coeffs_x;
    result.extend(coeffs_y);
    Ok(result)
}

/// Solve polynomial order 3 transformation
/// Requires 10+ GCPs (10 coefficients per equation)
fn solve_polynomial3(gcps: &[GCPData]) -> Result<Vec<f64>, String> {
    let n = gcps.len();
    if n < 10 {
        return Err("Minimum 10 GCPs required for 3rd order polynomial".to_string());
    }

    // 10 coefficients: 1, x, y, x^2, xy, y^2, x^3, x^2y, xy^2, y^3
    let num_coeffs = 10;
    let mut ata = vec![vec![0.0f64; num_coeffs]; num_coeffs];
    let mut atb_x = vec![0.0f64; num_coeffs];
    let mut atb_y = vec![0.0f64; num_coeffs];

    for gcp in gcps {
        let x = gcp.pixel_x;
        let y = gcp.pixel_y;
        let row = [
            1.0,
            x,
            y,
            x * x,
            x * y,
            y * y,
            x * x * x,
            x * x * y,
            x * y * y,
            y * y * y,
        ];

        for i in 0..num_coeffs {
            for j in 0..num_coeffs {
                ata[i][j] += row[i] * row[j];
            }
            atb_x[i] += row[i] * gcp.geo_x;
            atb_y[i] += row[i] * gcp.geo_y;
        }
    }

    let coeffs_x = solve_nxn(&ata, &atb_x)?;
    let coeffs_y = solve_nxn(&ata, &atb_y)?;

    let mut result = coeffs_x;
    result.extend(coeffs_y);
    Ok(result)
}

/// Solve NxN linear system using Gaussian elimination with partial pivoting
fn solve_nxn(a: &[Vec<f64>], b: &[f64]) -> Result<Vec<f64>, String> {
    let n = a.len();

    // Create augmented matrix
    let mut aug: Vec<Vec<f64>> = a
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let mut new_row = row.clone();
            new_row.push(b[i]);
            new_row
        })
        .collect();

    // Forward elimination with partial pivoting
    for col in 0..n {
        // Find pivot
        let mut max_row = col;
        for row in (col + 1)..n {
            if aug[row][col].abs() > aug[max_row][col].abs() {
                max_row = row;
            }
        }

        // Swap rows
        if max_row != col {
            aug.swap(col, max_row);
        }

        // Check for singular matrix
        if aug[col][col].abs() < 1e-12 {
            return Err("Singular matrix - GCPs may have poor distribution".to_string());
        }

        // Eliminate
        for row in (col + 1)..n {
            let factor = aug[row][col] / aug[col][col];
            for j in col..=n {
                aug[row][j] -= factor * aug[col][j];
            }
        }
    }

    // Back substitution
    let mut result = vec![0.0f64; n];
    for i in (0..n).rev() {
        result[i] = aug[i][n];
        for j in (i + 1)..n {
            result[i] -= aug[i][j] * result[j];
        }
        result[i] /= aug[i][i];
    }

    Ok(result)
}

/// Apply polynomial transformation to get predicted geo coordinates
fn apply_polynomial(coeffs: &[f64], pixel_x: f64, pixel_y: f64, order: u8) -> (f64, f64) {
    match order {
        1 => {
            // Affine: a0 + a1*x + a2*y
            let geo_x = coeffs[0] + coeffs[1] * pixel_x + coeffs[2] * pixel_y;
            let geo_y = coeffs[3] + coeffs[4] * pixel_x + coeffs[5] * pixel_y;
            (geo_x, geo_y)
        }
        2 => {
            // 2nd order polynomial
            let x = pixel_x;
            let y = pixel_y;
            let geo_x = coeffs[0]
                + coeffs[1] * x
                + coeffs[2] * y
                + coeffs[3] * x * x
                + coeffs[4] * x * y
                + coeffs[5] * y * y;
            let geo_y = coeffs[6]
                + coeffs[7] * x
                + coeffs[8] * y
                + coeffs[9] * x * x
                + coeffs[10] * x * y
                + coeffs[11] * y * y;
            (geo_x, geo_y)
        }
        3 => {
            // 3rd order polynomial
            let x = pixel_x;
            let y = pixel_y;
            let geo_x = coeffs[0]
                + coeffs[1] * x
                + coeffs[2] * y
                + coeffs[3] * x * x
                + coeffs[4] * x * y
                + coeffs[5] * y * y
                + coeffs[6] * x * x * x
                + coeffs[7] * x * x * y
                + coeffs[8] * x * y * y
                + coeffs[9] * y * y * y;
            let geo_y = coeffs[10]
                + coeffs[11] * x
                + coeffs[12] * y
                + coeffs[13] * x * x
                + coeffs[14] * x * y
                + coeffs[15] * y * y
                + coeffs[16] * x * x * x
                + coeffs[17] * x * x * y
                + coeffs[18] * x * y * y
                + coeffs[19] * y * y * y;
            (geo_x, geo_y)
        }
        _ => (0.0, 0.0),
    }
}

/// Calculate RMS error and per-GCP residuals
fn calculate_residuals(gcps: &[GCPData], coeffs: &[f64], order: u8) -> (f64, Vec<f64>) {
    let mut residuals = Vec::with_capacity(gcps.len());
    let mut sum_sq = 0.0;

    for gcp in gcps {
        let (pred_x, pred_y) = apply_polynomial(coeffs, gcp.pixel_x, gcp.pixel_y, order);
        let dx = pred_x - gcp.geo_x;
        let dy = pred_y - gcp.geo_y;
        let residual = (dx * dx + dy * dy).sqrt();
        residuals.push(residual);
        sum_sq += dx * dx + dy * dy;
    }

    let rms = (sum_sq / gcps.len() as f64).sqrt();
    (rms, residuals)
}

/// Thin Plate Spline transformation
/// Uses radial basis function: r^2 * ln(r)
struct ThinPlateSpline {
    gcps: Vec<GCPData>,
    weights_x: Vec<f64>,
    weights_y: Vec<f64>,
    affine_x: [f64; 3], // [a0, a1, a2] for x
    affine_y: [f64; 3], // [a0, a1, a2] for y
}

impl ThinPlateSpline {
    fn new(gcps: &[GCPData]) -> Result<Self, String> {
        let n = gcps.len();
        if n < 3 {
            return Err("Minimum 3 GCPs required for TPS".to_string());
        }

        // Build the TPS system matrix
        // [K  P] [w]   [v]
        // [P' 0] [a] = [0]
        //
        // K is n x n matrix of radial basis values
        // P is n x 3 matrix [1, x, y]
        // w is weights vector (n)
        // a is affine coefficients (3)
        // v is target values (n)

        let size = n + 3;
        let mut matrix = vec![vec![0.0f64; size]; size];

        // Fill K (radial basis)
        for i in 0..n {
            for j in 0..n {
                if i == j {
                    matrix[i][j] = 0.0;
                } else {
                    let r = Self::distance(&gcps[i], &gcps[j]);
                    matrix[i][j] = Self::basis(r);
                }
            }
        }

        // Fill P and P'
        for i in 0..n {
            matrix[i][n] = 1.0;
            matrix[i][n + 1] = gcps[i].pixel_x;
            matrix[i][n + 2] = gcps[i].pixel_y;
            matrix[n][i] = 1.0;
            matrix[n + 1][i] = gcps[i].pixel_x;
            matrix[n + 2][i] = gcps[i].pixel_y;
        }

        // Solve for X coordinates
        let mut b_x = vec![0.0f64; size];
        for i in 0..n {
            b_x[i] = gcps[i].geo_x;
        }
        let solution_x = solve_nxn(&matrix, &b_x)?;

        // Solve for Y coordinates
        let mut b_y = vec![0.0f64; size];
        for i in 0..n {
            b_y[i] = gcps[i].geo_y;
        }
        let solution_y = solve_nxn(&matrix, &b_y)?;

        Ok(ThinPlateSpline {
            gcps: gcps.to_vec(),
            weights_x: solution_x[..n].to_vec(),
            weights_y: solution_y[..n].to_vec(),
            affine_x: [solution_x[n], solution_x[n + 1], solution_x[n + 2]],
            affine_y: [solution_y[n], solution_y[n + 1], solution_y[n + 2]],
        })
    }

    fn distance(a: &GCPData, b: &GCPData) -> f64 {
        let dx = a.pixel_x - b.pixel_x;
        let dy = a.pixel_y - b.pixel_y;
        (dx * dx + dy * dy).sqrt()
    }

    fn basis(r: f64) -> f64 {
        if r < 1e-10 {
            0.0
        } else {
            r * r * r.ln()
        }
    }

    fn transform(&self, pixel_x: f64, pixel_y: f64) -> (f64, f64) {
        let mut geo_x = self.affine_x[0] + self.affine_x[1] * pixel_x + self.affine_x[2] * pixel_y;
        let mut geo_y = self.affine_y[0] + self.affine_y[1] * pixel_x + self.affine_y[2] * pixel_y;

        for (i, gcp) in self.gcps.iter().enumerate() {
            let dx = pixel_x - gcp.pixel_x;
            let dy = pixel_y - gcp.pixel_y;
            let r = (dx * dx + dy * dy).sqrt();
            let u = Self::basis(r);
            geo_x += self.weights_x[i] * u;
            geo_y += self.weights_y[i] * u;
        }

        (geo_x, geo_y)
    }

    fn calculate_residuals(&self, gcps: &[GCPData]) -> (f64, Vec<f64>) {
        let mut residuals = Vec::with_capacity(gcps.len());
        let mut sum_sq = 0.0;

        for gcp in gcps {
            let (pred_x, pred_y) = self.transform(gcp.pixel_x, gcp.pixel_y);
            let dx = pred_x - gcp.geo_x;
            let dy = pred_y - gcp.geo_y;
            let residual = (dx * dx + dy * dy).sqrt();
            residuals.push(residual);
            sum_sq += dx * dx + dy * dy;
        }

        let rms = (sum_sq / gcps.len() as f64).sqrt();
        (rms, residuals)
    }
}

/// Calculate transformation and RMS error from GCPs
#[tauri::command]
pub async fn calculate_transformation(
    gcps: Vec<GCPData>,
    transform_type: String,
) -> Result<TransformResult, String> {
    let min_gcps = min_gcps_for_transform(&transform_type);
    if gcps.len() < min_gcps {
        return Ok(TransformResult {
            success: false,
            rms_error: None,
            residuals: None,
            forward_transform: None,
            error: Some(format!(
                "Need at least {} GCPs for {} transformation, have {}",
                min_gcps,
                transform_type,
                gcps.len()
            )),
        });
    }

    match transform_type.as_str() {
        "polynomial1" => {
            let coeffs = solve_affine(&gcps)?;
            let (rms, residuals) = calculate_residuals(&gcps, &coeffs, 1);
            Ok(TransformResult {
                success: true,
                rms_error: Some(rms),
                residuals: Some(residuals),
                forward_transform: Some(coeffs),
                error: None,
            })
        }
        "polynomial2" => {
            let coeffs = solve_polynomial2(&gcps)?;
            let (rms, residuals) = calculate_residuals(&gcps, &coeffs, 2);
            Ok(TransformResult {
                success: true,
                rms_error: Some(rms),
                residuals: Some(residuals),
                forward_transform: Some(coeffs),
                error: None,
            })
        }
        "polynomial3" => {
            let coeffs = solve_polynomial3(&gcps)?;
            let (rms, residuals) = calculate_residuals(&gcps, &coeffs, 3);
            Ok(TransformResult {
                success: true,
                rms_error: Some(rms),
                residuals: Some(residuals),
                forward_transform: Some(coeffs),
                error: None,
            })
        }
        "tps" => {
            let tps = ThinPlateSpline::new(&gcps)?;
            let (rms, residuals) = tps.calculate_residuals(&gcps);
            // For TPS we don't return coefficients since they're complex
            Ok(TransformResult {
                success: true,
                rms_error: Some(rms),
                residuals: Some(residuals),
                forward_transform: None,
                error: None,
            })
        }
        _ => Err(format!("Unknown transformation type: {}", transform_type)),
    }
}

/// Apply georeferencing to create a new GeoTIFF
#[tauri::command]
pub async fn apply_georeference(
    app: AppHandle,
    input_path: String,
    output_path: String,
    gcps: Vec<GCPData>,
    transform_type: String,
    target_crs: String,
) -> Result<GeoreferenceResult, String> {
    let min_gcps = min_gcps_for_transform(&transform_type);
    if gcps.len() < min_gcps {
        return Ok(GeoreferenceResult {
            success: false,
            output_path: None,
            error: Some(format!(
                "Need at least {} GCPs for {} transformation",
                min_gcps, transform_type
            )),
        });
    }

    emit_progress(&app, "init", 0.0, "Opening source image...");

    // Open source dataset
    let src_ds = Dataset::open(&input_path)
        .map_err(|e| format!("Failed to open source image: {}", e))?;

    let (width, height) = src_ds.raster_size();
    let band_count = src_ds.raster_count();

    emit_progress(&app, "init", 0.1, "Preparing transformation...");

    // Get the GTiff driver
    let driver = DriverManager::get_driver_by_name("GTiff")
        .map_err(|e| format!("Failed to get GTiff driver: {}", e))?;

    // For polynomial transforms, we can compute a simple geotransform for affine
    // For higher order and TPS, we need to warp the image
    match transform_type.as_str() {
        "polynomial1" => {
            // Affine transformation - can use geotransform directly
            apply_affine_georeference(
                &app,
                &src_ds,
                &driver,
                &output_path,
                &gcps,
                &target_crs,
                width,
                height,
                band_count,
            )
        }
        "polynomial2" | "polynomial3" | "tps" => {
            // Higher order transforms require warping
            apply_warped_georeference(
                &app,
                &src_ds,
                &driver,
                &output_path,
                &gcps,
                &transform_type,
                &target_crs,
                width,
                height,
                band_count,
            )
        }
        _ => Err(format!("Unknown transformation type: {}", transform_type)),
    }
}

/// Create CRS from string (EPSG:xxxx or WKT)
fn create_spatial_ref(target_crs: &str) -> Result<SpatialRef, String> {
    if target_crs.starts_with("EPSG:") {
        let epsg: u32 = target_crs[5..]
            .parse()
            .map_err(|_| format!("Invalid EPSG code: {}", target_crs))?;
        SpatialRef::from_epsg(epsg).map_err(|e| format!("Failed to create SRS: {}", e))
    } else {
        SpatialRef::from_wkt(target_crs).map_err(|e| format!("Failed to parse CRS: {}", e))
    }
}

/// Apply affine georeferencing using geotransform
fn apply_affine_georeference(
    app: &AppHandle,
    src_ds: &Dataset,
    driver: &Driver,
    output_path: &str,
    gcps: &[GCPData],
    target_crs: &str,
    width: usize,
    height: usize,
    band_count: usize,
) -> Result<GeoreferenceResult, String> {
    use gdal::raster::GdalDataType;

    emit_progress(app, "compute", 0.15, "Computing affine transformation...");
    let coeffs = solve_affine(gcps)?;

    // Convert polynomial coefficients to GDAL geotransform
    // GDAL geotransform: [origin_x, pixel_width, row_rotation, origin_y, col_rotation, pixel_height]
    // Our coeffs: geo_x = a0 + a1*pixel_x + a2*pixel_y
    //             geo_y = b0 + b1*pixel_x + b2*pixel_y
    //
    // At pixel (0,0): geo_x = a0, geo_y = b0 (this is the origin)
    // pixel_width = a1 (change in geo_x per pixel in x direction)
    // pixel_height = b2 (change in geo_y per pixel in y direction, usually negative)
    // row_rotation = a2 (change in geo_x per pixel in y direction)
    // col_rotation = b1 (change in geo_y per pixel in x direction)

    let geotransform = [
        coeffs[0], // origin_x (a0)
        coeffs[1], // pixel_width (a1)
        coeffs[2], // row_rotation (a2)
        coeffs[3], // origin_y (b0)
        coeffs[4], // col_rotation (b1)
        coeffs[5], // pixel_height (b2)
    ];

    // Get the data type from the first band
    let first_band = src_ds
        .rasterband(1)
        .map_err(|e| format!("Failed to get first band: {}", e))?;
    let data_type = first_band.band_type();

    emit_progress(app, "create", 0.2, "Creating output file...");

    // Create output dataset with GTiff options for better compatibility
    let output_path_obj = Path::new(output_path);

    // Use gdal-rs create with options
    let mut options = CslStringList::new();
    options.add_string("COMPRESS=LZW").map_err(|e| format!("Failed to set option: {}", e))?;
    options.add_string("TILED=YES").map_err(|e| format!("Failed to set option: {}", e))?;
    options.add_string("BIGTIFF=IF_SAFER").map_err(|e| format!("Failed to set option: {}", e))?;

    let mut dst_ds = match data_type {
        GdalDataType::UInt8 => driver
            .create_with_band_type_with_options::<u8, _>(output_path_obj, width, height, band_count, &options)
            .map_err(|e| format!("Failed to create output file: {}", e))?,
        GdalDataType::UInt16 => driver
            .create_with_band_type_with_options::<u16, _>(output_path_obj, width, height, band_count, &options)
            .map_err(|e| format!("Failed to create output file: {}", e))?,
        GdalDataType::Int16 => driver
            .create_with_band_type_with_options::<i16, _>(output_path_obj, width, height, band_count, &options)
            .map_err(|e| format!("Failed to create output file: {}", e))?,
        GdalDataType::UInt32 => driver
            .create_with_band_type_with_options::<u32, _>(output_path_obj, width, height, band_count, &options)
            .map_err(|e| format!("Failed to create output file: {}", e))?,
        GdalDataType::Int32 => driver
            .create_with_band_type_with_options::<i32, _>(output_path_obj, width, height, band_count, &options)
            .map_err(|e| format!("Failed to create output file: {}", e))?,
        GdalDataType::Float32 => driver
            .create_with_band_type_with_options::<f32, _>(output_path_obj, width, height, band_count, &options)
            .map_err(|e| format!("Failed to create output file: {}", e))?,
        GdalDataType::Float64 => driver
            .create_with_band_type_with_options::<f64, _>(output_path_obj, width, height, band_count, &options)
            .map_err(|e| format!("Failed to create output file: {}", e))?,
        _ => driver
            .create_with_band_type_with_options::<f64, _>(output_path_obj, width, height, band_count, &options)
            .map_err(|e| format!("Failed to create output file: {}", e))?,
    };

    // Set geotransform BEFORE writing data (some drivers need this)
    dst_ds
        .set_geo_transform(&geotransform)
        .map_err(|e| format!("Failed to set geotransform: {}", e))?;

    // Set projection
    let crs = create_spatial_ref(target_crs)?;
    dst_ds
        .set_projection(&crs.to_wkt().map_err(|e| format!("Failed to get WKT: {}", e))?)
        .map_err(|e| format!("Failed to set projection: {}", e))?;

    // Copy pixel data from source bands to destination bands
    emit_progress(app, "copy", 0.3, "Copying raster data...");

    for band_idx in 1..=band_count {
        let progress = 0.3 + (band_idx as f32 / band_count as f32) * 0.5;
        emit_progress(app, "copy", progress, &format!("Copying band {}/{}...", band_idx, band_count));

        let src_band = src_ds
            .rasterband(band_idx)
            .map_err(|e| format!("Failed to get source band {}: {}", band_idx, e))?;

        let mut dst_band = dst_ds
            .rasterband(band_idx)
            .map_err(|e| format!("Failed to get output band {}: {}", band_idx, e))?;

        // Copy data based on actual data type to avoid precision issues
        match data_type {
            GdalDataType::UInt8 => {
                let src_data = src_band
                    .read_as::<u8>((0, 0), (width, height), (width, height), None)
                    .map_err(|e| format!("Failed to read source band: {}", e))?;
                let mut buffer = gdal::raster::Buffer::new((width, height), src_data.data().to_vec());
                dst_band
                    .write((0, 0), (width, height), &mut buffer)
                    .map_err(|e| format!("Failed to write output band: {}", e))?;
            }
            GdalDataType::UInt16 => {
                let src_data = src_band
                    .read_as::<u16>((0, 0), (width, height), (width, height), None)
                    .map_err(|e| format!("Failed to read source band: {}", e))?;
                let mut buffer = gdal::raster::Buffer::new((width, height), src_data.data().to_vec());
                dst_band
                    .write((0, 0), (width, height), &mut buffer)
                    .map_err(|e| format!("Failed to write output band: {}", e))?;
            }
            GdalDataType::Int16 => {
                let src_data = src_band
                    .read_as::<i16>((0, 0), (width, height), (width, height), None)
                    .map_err(|e| format!("Failed to read source band: {}", e))?;
                let mut buffer = gdal::raster::Buffer::new((width, height), src_data.data().to_vec());
                dst_band
                    .write((0, 0), (width, height), &mut buffer)
                    .map_err(|e| format!("Failed to write output band: {}", e))?;
            }
            GdalDataType::Float32 => {
                let src_data = src_band
                    .read_as::<f32>((0, 0), (width, height), (width, height), None)
                    .map_err(|e| format!("Failed to read source band: {}", e))?;
                let mut buffer = gdal::raster::Buffer::new((width, height), src_data.data().to_vec());
                dst_band
                    .write((0, 0), (width, height), &mut buffer)
                    .map_err(|e| format!("Failed to write output band: {}", e))?;
            }
            _ => {
                // Default to f64 for other types
                let src_data = src_band
                    .read_as::<f64>((0, 0), (width, height), (width, height), None)
                    .map_err(|e| format!("Failed to read source band: {}", e))?;
                let mut buffer = gdal::raster::Buffer::new((width, height), src_data.data().to_vec());
                dst_band
                    .write((0, 0), (width, height), &mut buffer)
                    .map_err(|e| format!("Failed to write output band: {}", e))?;
            }
        }
    }

    // Explicitly flush and close
    emit_progress(app, "finalize", 0.85, "Writing to disk...");
    dst_ds.flush_cache().map_err(|e| format!("Failed to flush cache: {}", e))?;
    drop(dst_ds);

    // Verify the output file can be opened and has data
    emit_progress(app, "verify", 0.95, "Verifying output...");
    std::thread::sleep(std::time::Duration::from_millis(200));
    match Dataset::open(output_path) {
        Ok(verify_ds) => {
            let (vw, vh) = verify_ds.raster_size();
            if vw == 0 || vh == 0 {
                return Ok(GeoreferenceResult {
                    success: false,
                    output_path: None,
                    error: Some("Output file was created but has no data".to_string()),
                });
            }
            emit_progress(app, "complete", 1.0, "Complete!");
            Ok(GeoreferenceResult {
                success: true,
                output_path: Some(output_path.to_string()),
                error: None,
            })
        }
        Err(e) => Ok(GeoreferenceResult {
            success: false,
            output_path: None,
            error: Some(format!("File created but cannot be opened: {}", e)),
        }),
    }
}

/// Apply warped georeferencing for polynomial2, polynomial3, and TPS
/// This requires resampling the image with the non-linear transformation
fn apply_warped_georeference(
    app: &AppHandle,
    src_ds: &Dataset,
    driver: &Driver,
    output_path: &str,
    gcps: &[GCPData],
    transform_type: &str,
    target_crs: &str,
    width: usize,
    height: usize,
    band_count: usize,
) -> Result<GeoreferenceResult, String> {
    // For non-linear transforms, we need to:
    // 1. Compute output bounds from transformed corners
    // 2. Create output raster with appropriate geotransform
    // 3. Resample source pixels using inverse transform

    emit_progress(app, "compute", 0.15, "Computing transformation coefficients...");

    // Determine transformation order or use TPS
    let (is_tps, order) = match transform_type {
        "polynomial2" => (false, 2u8),
        "polynomial3" => (false, 3u8),
        "tps" => (true, 0u8),
        _ => return Err("Invalid transform type for warping".to_string()),
    };

    // Compute coefficients or TPS
    let coeffs = if !is_tps {
        match order {
            2 => solve_polynomial2(gcps)?,
            3 => solve_polynomial3(gcps)?,
            _ => return Err("Invalid polynomial order".to_string()),
        }
    } else {
        vec![] // TPS doesn't use simple coefficients
    };

    let tps = if is_tps {
        Some(ThinPlateSpline::new(gcps)?)
    } else {
        None
    };

    // Transform corners to find output bounds
    let corners = [
        (0.0, 0.0),
        (width as f64, 0.0),
        (width as f64, height as f64),
        (0.0, height as f64),
    ];

    let transformed_corners: Vec<(f64, f64)> = corners
        .iter()
        .map(|(px, py)| {
            if is_tps {
                tps.as_ref().unwrap().transform(*px, *py)
            } else {
                apply_polynomial(&coeffs, *px, *py, order)
            }
        })
        .collect();

    let min_x = transformed_corners.iter().map(|(x, _)| *x).fold(f64::INFINITY, f64::min);
    let max_x = transformed_corners.iter().map(|(x, _)| *x).fold(f64::NEG_INFINITY, f64::max);
    let min_y = transformed_corners.iter().map(|(_, y)| *y).fold(f64::INFINITY, f64::min);
    let max_y = transformed_corners.iter().map(|(_, y)| *y).fold(f64::NEG_INFINITY, f64::max);

    // Compute output pixel size (approximate, based on input resolution)
    let pixel_width = (max_x - min_x) / width as f64;
    let pixel_height = -(max_y - min_y) / height as f64; // negative for top-down

    let geotransform = [
        min_x,        // origin_x
        pixel_width,  // pixel_width
        0.0,          // row_rotation
        max_y,        // origin_y (top)
        0.0,          // col_rotation
        pixel_height, // pixel_height (negative)
    ];

    // Get the data type from the first band
    use gdal::raster::GdalDataType;
    let first_band = src_ds
        .rasterband(1)
        .map_err(|e| format!("Failed to get first band: {}", e))?;
    let data_type = first_band.band_type();

    emit_progress(app, "create", 0.2, "Creating output file...");

    // Create output dataset with GTiff options, preserving source data type
    let output_path_obj = Path::new(output_path);
    let mut options = CslStringList::new();
    options.add_string("COMPRESS=LZW").map_err(|e| format!("Failed to set option: {}", e))?;
    options.add_string("TILED=YES").map_err(|e| format!("Failed to set option: {}", e))?;
    options.add_string("BIGTIFF=IF_SAFER").map_err(|e| format!("Failed to set option: {}", e))?;

    let mut dst_ds = match data_type {
        GdalDataType::UInt8 => driver
            .create_with_band_type_with_options::<u8, _>(output_path_obj, width, height, band_count, &options)
            .map_err(|e| format!("Failed to create output file: {}", e))?,
        GdalDataType::UInt16 => driver
            .create_with_band_type_with_options::<u16, _>(output_path_obj, width, height, band_count, &options)
            .map_err(|e| format!("Failed to create output file: {}", e))?,
        GdalDataType::Int16 => driver
            .create_with_band_type_with_options::<i16, _>(output_path_obj, width, height, band_count, &options)
            .map_err(|e| format!("Failed to create output file: {}", e))?,
        GdalDataType::UInt32 => driver
            .create_with_band_type_with_options::<u32, _>(output_path_obj, width, height, band_count, &options)
            .map_err(|e| format!("Failed to create output file: {}", e))?,
        GdalDataType::Int32 => driver
            .create_with_band_type_with_options::<i32, _>(output_path_obj, width, height, band_count, &options)
            .map_err(|e| format!("Failed to create output file: {}", e))?,
        GdalDataType::Float32 => driver
            .create_with_band_type_with_options::<f32, _>(output_path_obj, width, height, band_count, &options)
            .map_err(|e| format!("Failed to create output file: {}", e))?,
        GdalDataType::Float64 => driver
            .create_with_band_type_with_options::<f64, _>(output_path_obj, width, height, band_count, &options)
            .map_err(|e| format!("Failed to create output file: {}", e))?,
        _ => driver
            .create_with_band_type_with_options::<f64, _>(output_path_obj, width, height, band_count, &options)
            .map_err(|e| format!("Failed to create output file: {}", e))?,
    };

    // Set geotransform and projection
    dst_ds
        .set_geo_transform(&geotransform)
        .map_err(|e| format!("Failed to set geotransform: {}", e))?;

    let crs = create_spatial_ref(target_crs)?;
    dst_ds
        .set_projection(&crs.to_wkt().map_err(|e| format!("Failed to get WKT: {}", e))?)
        .map_err(|e| format!("Failed to set projection: {}", e))?;

    // For each band, resample using inverse transform
    // This is a simplified nearest-neighbor resampling
    emit_progress(app, "warp", 0.25, "Warping raster data...");

    for band_idx in 1..=band_count {
        let band_progress_start = 0.25 + (band_idx as f32 - 1.0) / band_count as f32 * 0.6;
        emit_progress(app, "warp", band_progress_start, &format!("Warping band {}/{}...", band_idx, band_count));

        let src_band = src_ds
            .rasterband(band_idx)
            .map_err(|e| format!("Failed to get source band {}: {}", band_idx, e))?;

        // Read entire source band as f64
        let src_buffer = src_band
            .read_as::<f64>((0, 0), (width, height), (width, height), None)
            .map_err(|e| format!("Failed to read source band: {}", e))?;
        let src_data = src_buffer.data();

        // Create output buffer as f64 to preserve precision
        // Use parallel processing for the warping loop
        let rows_completed = AtomicUsize::new(0);
        let total_rows = height;

        // Process rows in parallel
        let dst_data: Vec<f64> = (0..height)
            .into_par_iter()
            .flat_map(|out_y| {
                // Process one row
                let row: Vec<f64> = (0..width)
                    .map(|out_x| {
                        // Convert output pixel to geo coordinates
                        let geo_x = geotransform[0] + (out_x as f64 + 0.5) * geotransform[1];
                        let geo_y = geotransform[3] + (out_y as f64 + 0.5) * geotransform[5];

                        // Find source pixel using iterative inverse
                        let (src_x, src_y) = find_source_pixel(
                            geo_x,
                            geo_y,
                            width,
                            height,
                            &coeffs,
                            order,
                            tps.as_ref(),
                            is_tps,
                        );

                        // Bilinear interpolation
                        if src_x >= 0.0 && src_x < (width - 1) as f64 && src_y >= 0.0 && src_y < (height - 1) as f64 {
                            let x0 = src_x.floor() as usize;
                            let y0 = src_y.floor() as usize;
                            let x1 = x0 + 1;
                            let y1 = y0 + 1;

                            // Fractional parts
                            let dx = src_x - x0 as f64;
                            let dy = src_y - y0 as f64;

                            // Get 4 surrounding pixels
                            let p00 = src_data[y0 * width + x0];
                            let p10 = src_data[y0 * width + x1];
                            let p01 = src_data[y1 * width + x0];
                            let p11 = src_data[y1 * width + x1];

                            // Bilinear interpolation
                            let value = p00 * (1.0 - dx) * (1.0 - dy)
                                      + p10 * dx * (1.0 - dy)
                                      + p01 * (1.0 - dx) * dy
                                      + p11 * dx * dy;
                            return value;
                        }
                        0.0
                    })
                    .collect();

                // Update progress counter
                let completed = rows_completed.fetch_add(1, Ordering::Relaxed);
                // Emit progress every 5% of rows (from main thread approximation)
                if completed % (total_rows / 20).max(1) == 0 {
                    let row_progress = completed as f32 / total_rows as f32;
                    let band_progress = band_progress_start + row_progress * (0.6 / band_count as f32);
                    emit_progress(app, "warp", band_progress, &format!("Warping band {}/{} ({:.0}%)...", band_idx, band_count, row_progress * 100.0));
                }

                row
            })
            .collect();

        // Write output band using Buffer
        let mut dst_buffer = gdal::raster::Buffer::new((width, height), dst_data);
        let mut dst_band = dst_ds
            .rasterband(band_idx)
            .map_err(|e| format!("Failed to get output band {}: {}", band_idx, e))?;

        dst_band
            .write((0, 0), (width, height), &mut dst_buffer)
            .map_err(|e| format!("Failed to write output band: {}", e))?;
    }

    // Explicitly flush and close
    emit_progress(app, "finalize", 0.9, "Writing to disk...");
    let _ = dst_ds.flush_cache();
    drop(dst_ds);

    // Verify the output file can be opened
    emit_progress(app, "verify", 0.95, "Verifying output...");
    std::thread::sleep(std::time::Duration::from_millis(100));
    match Dataset::open(output_path) {
        Ok(_) => {
            emit_progress(app, "complete", 1.0, "Complete!");
            Ok(GeoreferenceResult {
                success: true,
                output_path: Some(output_path.to_string()),
                error: None,
            })
        }
        Err(e) => Ok(GeoreferenceResult {
            success: false,
            output_path: None,
            error: Some(format!("File created but cannot be opened: {}", e)),
        }),
    }
}

/// Find source pixel coordinates for a given geo coordinate
/// Uses iterative search for inverse transform
fn find_source_pixel(
    target_geo_x: f64,
    target_geo_y: f64,
    width: usize,
    height: usize,
    coeffs: &[f64],
    order: u8,
    tps: Option<&ThinPlateSpline>,
    is_tps: bool,
) -> (f64, f64) {
    // Newton-Raphson iteration to find inverse transform
    // Start from center of image (good initial guess for most cases)
    let mut px = width as f64 / 2.0;
    let mut py = height as f64 / 2.0;

    // Reduced iterations (10 is usually enough) and practical tolerance
    // 0.01 pixel accuracy is more than sufficient for nearest-neighbor sampling
    for _ in 0..10 {
        let (gx, gy) = if is_tps {
            tps.unwrap().transform(px, py)
        } else {
            apply_polynomial(coeffs, px, py, order)
        };

        let dx = target_geo_x - gx;
        let dy = target_geo_y - gy;

        // Early exit if converged (within ~0.01 pixel)
        if dx.abs() < 1e-8 && dy.abs() < 1e-8 {
            break;
        }

        // Estimate Jacobian numerically with smaller delta for accuracy
        let delta = 0.5;
        let (gx_dx, gy_dx) = if is_tps {
            tps.unwrap().transform(px + delta, py)
        } else {
            apply_polynomial(coeffs, px + delta, py, order)
        };
        let (gx_dy, gy_dy) = if is_tps {
            tps.unwrap().transform(px, py + delta)
        } else {
            apply_polynomial(coeffs, px, py + delta, order)
        };

        let j11 = (gx_dx - gx) / delta;
        let j12 = (gx_dy - gx) / delta;
        let j21 = (gy_dx - gy) / delta;
        let j22 = (gy_dy - gy) / delta;

        // Invert 2x2 Jacobian
        let det = j11 * j22 - j12 * j21;
        if det.abs() < 1e-12 {
            break;
        }

        let inv_j11 = j22 / det;
        let inv_j12 = -j12 / det;
        let inv_j21 = -j21 / det;
        let inv_j22 = j11 / det;

        // Update pixel coordinates
        px += inv_j11 * dx + inv_j12 * dy;
        py += inv_j21 * dx + inv_j22 * dy;

        // Clamp to valid range with some margin
        let w = width as f64;
        let h = height as f64;
        px = px.clamp(-w, 2.0 * w);
        py = py.clamp(-h, 2.0 * h);
    }

    (px, py)
}
