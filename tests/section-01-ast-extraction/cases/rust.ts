export const RUST_COMPLEX_CODE = `
pub struct BufferManager {
    capacity: usize,
}

pub trait StorageBackend {
    fn write_block(&mut self, offset: u64, data: &[u8]) -> Result<(), String>;
    fn flush(&mut self);
}

impl BufferManager {
    pub const DEFAULT_CAPACITY: usize = 4096;

    pub unsafe fn allocate_raw(size: usize) -> *mut u8 {
        std::ptr::null_mut()
    }

    pub async fn async_sync(&self) -> bool {
        true
    }
}
`;
