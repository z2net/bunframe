//! THE single descriptor aggregation of the bunframe core: one
//! explicit `ModuleDef` (functions, the `WindowConfig` record and
//! the typed errors table) consumed by the `emit-json` binary
//! (which materializes `.bffi/bffi.api.json` for the `@z2net/bffi`
//! pipeline).

use bffi::{ErrorDef, FunctionDef, ModuleDef, RecordDef};

/// The `#[bffi]` functions of the core, in declaration order.
pub const FUNCTIONS: &[FunctionDef] = &[
    crate::bffi_meta_window_open::FUNCTION,
    crate::bffi_meta_window_events::FUNCTION,
    crate::bffi_meta_window_close::FUNCTION,
    crate::bffi_meta_window_eval::FUNCTION,
    crate::bffi_meta_window_set_title::FUNCTION,
    crate::bffi_meta_window_set_size::FUNCTION,
    crate::bffi_meta_window_set_resizable::FUNCTION,
    crate::bffi_meta_window_set_decorations::FUNCTION,
    crate::bffi_meta_window_set_always_on_top::FUNCTION,
    crate::bffi_meta_window_set_visible::FUNCTION,
    crate::bffi_meta_window_focus::FUNCTION,
    crate::bffi_meta_window_maximize::FUNCTION,
    crate::bffi_meta_window_unmaximize::FUNCTION,
    crate::bffi_meta_window_minimize::FUNCTION,
    crate::bffi_meta_window_open_devtools::FUNCTION,
    crate::bffi_meta_window_bind_ipc::FUNCTION,
    crate::bffi_meta_window_ipc_reply::FUNCTION,
    crate::bffi_meta_window_bind_close::FUNCTION,
    crate::bffi_meta_window_poll_exit::FUNCTION,
    crate::bffi_meta_app_quit::FUNCTION,
    crate::bffi_meta_loop_pump::FUNCTION,
];

/// The record types of the core.
pub const RECORDS: &[RecordDef] = &[crate::WindowConfig::BFFI_RECORD_DEF];

/// The typed errors of the core.
pub const ERRORS: &[ErrorDef] = &[crate::BunframeError::BFFI_ERROR_DEF];

/// The full module definition.
pub const MODULE: ModuleDef = ModuleDef {
    name: "bunframe",
    fns: FUNCTIONS,
    classes: &[],
    records: RECORDS,
    enums: &[],
    errors: ERRORS,
};
