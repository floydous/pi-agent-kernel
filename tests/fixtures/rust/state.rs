//! Realistic Rust state fixture with multiple modules, traits, generics, and async.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub static ENABLED: bool = true;
pub const DEFAULT_MAX_CONNECTIONS: usize = 1024;

pub mod time {
    pub fn elapsed_ms(start: std::time::Instant) -> u128 {
        start.elapsed().as_millis()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Active,
    Paused,
    Stopped,
}

#[derive(Debug)]
pub struct Config {
    pub max_connections: usize,
    pub timeout: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            max_connections: DEFAULT_MAX_CONNECTIONS,
            timeout: Duration::from_secs(30),
        }
    }
}

pub struct AppStateInner {
    pub active_connections: usize,
    pub metrics: HashMap<&'static str, AtomicU64>,
}

impl AppStateInner {
    pub fn new() -> Self {
        let mut metrics = HashMap::new();
        metrics.insert("requests", AtomicU64::new(0));
        metrics.insert("errors", AtomicU64::new(0));
        Self {
            active_connections: 0,
            metrics,
        }
    }
}

impl Default for AppStateInner {
    fn default() -> Self {
        Self::new()
    }
}

pub trait Connect {
    fn connect(&self) -> Result<(), String>;
    fn disconnect(&self) -> Result<(), String>;
    fn is_connected(&self) -> bool;
}

pub struct AppState {
    inner: AppStateInner,
    state: State,
    config: Config,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: AppStateInner::new(),
            state: State::Active,
            config: Config::default(),
        }
    }

    pub fn new_with_config(config: Config) -> Self {
        Self {
            inner: AppStateInner::new(),
            state: State::Active,
            config,
        }
    }

    pub fn state(&self) -> &State {
        &self.state
    }

    pub fn set_state(&mut self, state: State) {
        self.state = state;
    }

    pub fn record_request(&self) {
        if let Some(counter) = self.inner.metrics.get("requests") {
            counter.fetch_add(1, Ordering::SeqCst);
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl Connect for AppState {
    fn connect(&self) -> Result<(), String> {
        if self.state == State::Stopped {
            return Err("cannot connect when stopped".to_string());
        }
        Ok(())
    }

    fn disconnect(&self) -> Result<(), String> {
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.state == State::Active
    }
}
