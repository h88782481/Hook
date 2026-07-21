#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::*;

#[cfg(not(windows))]
compile_error!("scap-targets currently supports Windows only (Hook is Windows-first)");
