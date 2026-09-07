// Rust fixture: real-world task worker with multiple impls, traits, generics, and unsafe blocks.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerState {
    Idle,
    Running,
    Stopped,
}

pub trait StorageBackend {
    fn write_block(&mut self, offset: u64, data: &[u8]) -> Result<(), String>;
    fn flush(&mut self);
    fn capacity(&self) -> usize;
}

pub struct TaskWorker<T: Send + Sync + 'static> {
    pub worker_id: u32,
    pub label: String,
    state: WorkerState,
    counter: AtomicU64,
    backend: Box<dyn StorageBackend + Send>,
    _phantom: std::marker::PhantomData<T>,
}

pub const DEFAULT_CAPACITY: usize = 4096;

impl<T: Send + Sync + 'static> TaskWorker<T> {
    pub fn new(worker_id: u32, label: impl Into<String>, backend: Box<dyn StorageBackend + Send>) -> Self {
        Self {
            worker_id,
            label: label.into(),
            state: WorkerState::Idle,
            counter: AtomicU64::new(0),
            backend,
            _phantom: std::marker::PhantomData,
        }
    }

    pub unsafe fn allocate_raw(size: usize) -> *mut u8 {
        if size == 0 {
            return std::ptr::null_mut();
        }
        let layout = std::alloc::Layout::from_size_align(size, 8).unwrap();
        std::alloc::alloc(layout)
    }

    pub async fn process_job(&self, job_name: &str) -> Result<(), String> {
        self.state = WorkerState::Running;
        self.counter.fetch_add(1, Ordering::SeqCst);
        // Real work would dispatch to a thread pool.
        if job_name.is_empty() {
            return Err("empty job name".to_string());
        }
        Ok(())
    }

    pub fn stop(&mut self) {
        self.backend.flush();
        self.state = WorkerState::Stopped;
    }

    pub fn state(&self) -> WorkerState {
        self.state
    }
}

impl<T: Send + Sync + 'static> Drop for TaskWorker<T> {
    fn drop(&mut self) {
        self.stop();
    }
}
