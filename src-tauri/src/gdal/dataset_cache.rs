use crate::gdal::{georef, overview};
use gdal::Dataset;
use lru::LruCache;
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex, MutexGuard};

/// GDAL Dataset is !Send because its internal C pointer is not safe to move
/// across threads. However it IS safe to access from a single thread at a time,
/// which is exactly what Mutex<SendDataset> guarantees.
pub struct SendDataset(pub Dataset);
unsafe impl Send for SendDataset {}

impl SendDataset {
    /// Wrap a long-lived handle, letting it cache its RPC model (and DEM) and
    /// the overview levels it opens.
    pub(crate) fn new(dataset: Dataset) -> Self {
        georef::register_rpc_cache(&dataset);
        overview::register_overview_cache(&dataset);
        Self(dataset)
    }
}

impl Drop for SendDataset {
    fn drop(&mut self) {
        // Before the handle closes, so a reused handle address never hits a
        // stale model.
        overview::unregister_overview_cache(&self.0);
        georef::unregister_rpc_cache(&self.0);
    }
}

/// Number of pre-opened dataset handles per layer. Allows this many tiles to
/// render concurrently for the same layer without serializing on one lock.
const POOL_SIZE: usize = 8;

/// A fixed pool of open GDAL dataset handles for one registered layer.
/// Tile commands check out a handle (non-blocking if a slot is free, blocking
/// on the first slot otherwise), do their warp, and release.
pub struct DatasetPool {
    path: String,
    slots: Vec<Mutex<SendDataset>>,
}

impl DatasetPool {
    fn new(path: String, dataset: Dataset) -> Result<Self, String> {
        let mut slots = Vec::with_capacity(POOL_SIZE);
        slots.push(Mutex::new(SendDataset::new(dataset)));
        for _ in 1..POOL_SIZE {
            let ds = Dataset::open(&path).map_err(|e| format!("pool open: {}", e))?;
            slots.push(Mutex::new(SendDataset::new(ds)));
        }
        Ok(Self { path, slots })
    }

    /// Check out a dataset handle. Prefers an idle slot (try_lock); falls back
    /// to blocking on slot 0 if all are busy.
    pub fn checkout(&self) -> MutexGuard<'_, SendDataset> {
        for slot in &self.slots {
            if let Ok(guard) = slot.try_lock() {
                return guard;
            }
        }
        self.slots[0].lock().unwrap()
    }

    pub fn path(&self) -> &str {
        &self.path
    }
}

pub struct DatasetCache {
    inner: Mutex<LruCache<String, Arc<DatasetPool>>>,
}

unsafe impl Send for DatasetCache {}
unsafe impl Sync for DatasetCache {}

impl DatasetCache {
    pub fn new(capacity: usize) -> Self {
        let cap = NonZeroUsize::new(capacity).unwrap_or(NonZeroUsize::new(10).unwrap());
        Self {
            inner: Mutex::new(LruCache::new(cap)),
        }
    }

    pub fn add(&self, id: String, path: String, dataset: Dataset) {
        match DatasetPool::new(path, dataset) {
            Ok(pool) => {
                let mut cache = self.inner.lock().unwrap();
                cache.put(id, Arc::new(pool));
            }
            Err(e) => eprintln!("[DatasetCache] pool init failed: {}", e),
        }
    }

    pub fn get_path(&self, id: &str) -> Option<String> {
        let mut cache = self.inner.lock().unwrap();
        cache.get(id).map(|p| p.path().to_string())
    }

    /// Returns a shared pool handle. Call `.checkout()` to borrow a dataset.
    pub fn get_pool(&self, id: &str) -> Option<Arc<DatasetPool>> {
        let mut cache = self.inner.lock().unwrap();
        cache.get(id).map(Arc::clone)
    }

    /// Replace a dataset's handles with freshly opened ones, e.g. so they pick
    /// up a newly built `.ovr`. Tiles in flight keep their old pool alive.
    pub fn reopen(&self, id: &str) -> Result<(), String> {
        let path = self.get_path(id).ok_or("Dataset not found")?;
        let dataset = Dataset::open(&path).map_err(|e| format!("reopen: {}", e))?;
        let pool = Arc::new(DatasetPool::new(path, dataset)?);
        self.inner.lock().unwrap().put(id.to_string(), pool);
        Ok(())
    }

    /// Remove a dataset, returning its path.
    pub fn remove(&self, id: &str) -> Option<String> {
        let mut cache = self.inner.lock().unwrap();
        cache.pop(id).map(|p| p.path().to_string())
    }

    /// Whether any cached dataset was opened from `path`.
    pub fn has_path(&self, path: &str) -> bool {
        let cache = self.inner.lock().unwrap();
        cache.iter().any(|(_, p)| p.path() == path)
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        let cache = self.inner.lock().unwrap();
        cache.len()
    }
}
