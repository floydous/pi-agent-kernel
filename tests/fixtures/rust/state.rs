pub static ENABLED: bool = true;

pub struct AppStateInner {
    pub active_connections: usize,
}

pub enum State {
    Active,
    Paused,
}

pub struct AppState {
    inner: AppStateInner,
}

impl AppState {
    pub fn new() -> Self {
        let initial = 0;  // local var must NOT be a top-level symbol
        AppState {
            inner: AppStateInner { active_connections: initial },
        }
    }

    pub async fn connect(&mut self) -> Result<(), String> {
        // Comment references to add_record should be IGNORED.
        Ok(())
    }
}
