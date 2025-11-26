use lru::LruCache;
use std::num::NonZeroUsize;
use std::sync::Mutex;

/// Stores file paths for datasets (not the datasets themselves, since GDAL Dataset is not thread-safe)
/// Each command will open the dataset as needed
pub struct DatasetCache {
    paths: Mutex<LruCache<String, String>>,
}

// Safety: We only store paths (Strings), which are Send + Sync
unsafe impl Send for DatasetCache {}
unsafe impl Sync for DatasetCache {}

impl DatasetCache {
    pub fn new(capacity: usize) -> Self {
        let cap = NonZeroUsize::new(capacity).unwrap_or(NonZeroUsize::new(10).unwrap());
        Self {
            paths: Mutex::new(LruCache::new(cap)),
        }
    }

    pub fn get_path(&self, id: &str) -> Option<String> {
        let mut cache = self.paths.lock().unwrap();
        cache.get(id).cloned()
    }

    pub fn add(&self, id: String, path: String) {
        let mut cache = self.paths.lock().unwrap();
        cache.put(id, path);
    }

    pub fn remove(&self, id: &str) {
        let mut cache = self.paths.lock().unwrap();
        cache.pop(id);
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        let cache = self.paths.lock().unwrap();
        cache.len()
    }
}
