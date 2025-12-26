use lru::LruCache;
use std::num::NonZeroUsize;
use std::sync::Mutex;

/// Stores file paths for datasets (not the datasets themselves, since GDAL Dataset is not thread-safe).
/// Each command will open the dataset fresh as needed.
///
/// # Thread Safety
///
/// This struct is safe to share across threads because:
/// - The only field is `Mutex<LruCache<String, String>>`
/// - `Mutex<T>` is `Send + Sync` when `T: Send`
/// - `LruCache<String, String>` contains only `String` which is `Send + Sync`
/// - All access to the inner cache goes through the Mutex
///
/// The manual `Send` and `Sync` implementations are required because the compiler
/// cannot automatically derive them due to the LruCache type's internal structure,
/// but the invariants above guarantee safety.
pub struct DatasetCache {
    paths: Mutex<LruCache<String, String>>,
}

// SAFETY: DatasetCache only contains Mutex<LruCache<String, String>>.
// - Mutex<T> is Send when T: Send (LruCache<String, String> is Send)
// - Mutex<T> is Sync when T: Send (same reasoning)
// - All operations acquire the mutex lock before accessing the cache
// - String is both Send and Sync
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
