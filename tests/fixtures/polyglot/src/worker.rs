pub struct TaskWorker {
    pub worker_id: u32,
}

impl TaskWorker {
    pub unsafe fn spawn_raw(id: u32) -> *mut TaskWorker {
        std::ptr::null_mut()
    }

    pub async fn process_job(&self, job_name: &str) -> Result<(), String> {
        Ok(())
    }
}
