use gdal::Dataset;
use lru::LruCache;
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex, MutexGuard};

/// GDAL Dataset is !Send because its internal C pointer is not safe to move
/// across threads. However it IS safe to access from a single thread at a time,
/// which is exactly what Mutex<SendDataset> guarantees.
pub struct SendDataset(pub Dataset);
unsafe impl Send for SendDataset {}

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
        slots.push(Mutex::new(SendDataset(dataset)));
        for _ in 1..POOL_SIZE {
            let ds = Dataset::open(&path).map_err(|e| format!("pool open: {}", e))?;
            slots.push(Mutex::new(SendDataset(ds)));
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

    pub fn remove(&self, id: &str) {
        let mut cache = self.inner.lock().unwrap();
        cache.pop(id);
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        let cache = self.inner.lock().unwrap();
        cache.len()
    }
}
