//! bunframe-core: the native shell of the bunframe desktop shell for
//! Bun - a **wry** (webview) binding productized from the bffi wry
//! example. Windows, the event loop and the webview surfaces live on
//! a dedicated native thread; the Bun thread stays free and drains
//! the bffi event loop with [`loop_pump`].
//!
//! The threading model (see the
//! [Binding GUI guide](https://github.com/z2net/bffi-rs/blob/main/docs/BINDING-GUI.md)):
//!
//! - a `winit::EventLoopProxy` (`send_event`): every JS-facing
//!   command proxies onto the loop thread;
//! - [`bffi::invoke_wait`]: the loop-thread IPC handler and the
//!   close-veto check park until the JS thread delivers the callback
//!   answer by pumping - the dispatch calls the bound `JSCallback`
//!   pointer synchronously;
//! - the events STREAM (bffi push stream): window events
//!   (`resized` / `focused` / `close-denied` / `closed`) cross as
//!   JSON strings with backpressure - the JS side pulls through the
//!   stream API, no pump involvement.
//!
//! Closing: a title-bar X (or `window_close`) first consults the
//! close-veto callback when one is bound (`invoke_wait`, the
//! callback returns `true` to ALLOW the close, `false` to deny;
//! fail-open on timeout) - then the window drops, a `closed` event
//! is pushed, the events stream completes, and the loop exits when
//! the last window went.
//!
//! Windows-first: on Windows the loop thread uses
//! `with_any_thread(true)` (the OS main thread belongs to the Bun
//! host). macOS requires windows on the OS main thread and is not
//! supported by this crate yet.
//!
//! Aggregation lives in [`module_def`] (single source); the
//! `emit-json` binary materializes `.bffi/bffi.api.json` from it.

// The runtime ABI exports (bffi_error_*, the bffi_buffer pair,
// bffi_types_free): the JS pipeline drains errors and reads buffers
// through them.
bffi::bffi_runtime_abi!(module = crate::module_def::MODULE);

// The generic callback exports (bffi_callback_set_thread/_bind/
// _invoke/_revoke): the JS-side bind surface.
bffi::bffi_callback_abi!();

// The stream exports (bffi_stream_next/_drop/_set_wake): the JS side
// pulls the window-events stream through them.
bffi::bffi_stream_abi!();

pub mod module_def;

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{
    Arc, Condvar, LazyLock, Mutex, MutexGuard, PoisonError,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use bffi::bffi_stream::Ctx;
use bffi::{
    BffiError, BffiRecord, ErrorCode, Handle, Registry, TypeTag, Value, bffi, invoke_wait, pump,
    spawn_push,
};
use pollster::block_on;
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalPosition, LogicalSize, PhysicalPosition};
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
use winit::window::{Window, WindowId, WindowLevel};
use wry::http::{self, Response, StatusCode};
use wry::{WebView, WebViewBuilder};

// On Windows the OS main thread belongs to the Bun host, so the
// loop thread must be allowed to own the winit event loop.
#[cfg(windows)]
use winit::platform::windows::EventLoopBuilderExtWindows as _;
#[cfg(windows)]
use winit::platform::windows::WindowAttributesExtWindows as _;

/// The registry tag of the bunframe window table (a user-owned slice
/// outside the framework tags).
const WINDOW_TAG: TypeTag = TypeTag(0x0710);

/// How long the loop-thread IPC handler parks waiting for the JS
/// reply before the page promise is settled with an error object.
const IPC_TIMEOUT: Duration = Duration::from_secs(30);

/// How long the loop-thread veto check waits for the JS answer
/// before the close proceeds (fail-open).
const VETO_TIMEOUT: Duration = Duration::from_secs(10);

/// How long [`window_open`] waits for the loop thread to confirm
/// the window creation.
const CREATE_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a window query ([`window_is_maximized`] and friends)
/// waits for the loop thread to answer.
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);

/// How long [`ensure_loop`] waits for the freshly spawned loop
/// thread to publish its proxy.
const LOOP_START_TIMEOUT: Duration = Duration::from_secs(10);

/// The default window size when the config omits width/height.
const DEFAULT_WIDTH: u32 = 1024;
const DEFAULT_HEIGHT: u32 = 768;

/// The default window title when the config omits one.
const DEFAULT_TITLE: &str = "bunframe";

/// The domain error of the crate (the typed errors table in
/// [`module_def`]; codes `0x1001..`).
#[derive(BffiError, Debug)]
pub enum BunframeError {
    /// The handle is null, stale, or belongs to a closed window.
    #[bffi(code = 0x1001)]
    InvalidHandle,
    /// The loop thread is not running (it stopped or never started).
    #[bffi(code = 0x1002)]
    LoopNotRunning,
    /// The window/webview creation failed on the loop thread.
    #[bffi(code = 0x1003)]
    CreateFailed {
        /// The failure message.
        message: String,
    },
    /// A window operation failed on the loop thread.
    #[bffi(code = 0x1004)]
    OperationFailed {
        /// The failure message.
        message: String,
    },
    /// A bound callback handle is null or has the wrong signature.
    #[bffi(code = 0x1005)]
    InvalidCallback {
        /// The reason the handle was rejected.
        message: String,
    },
    /// The events stream of the window is not available.
    #[bffi(code = 0x1006)]
    EventsUnavailable,
}

/// The open request: everything optional (`None` rides the
/// `TAG_UNIT` wire byte and arrives as `null` on the JS side).
/// Exactly one of `url`/`html` should be set; `html` wins if both
/// are (wry ignores `url` when `html` is present). Sizes and
/// positions are LOGICAL pixels. Without `x`/`y` the OS picks the
/// position.
#[derive(BffiRecord, Clone, Debug, Default, PartialEq)]
pub struct WindowConfig {
    /// The URL to load.
    pub url: Option<String>,
    /// The inline HTML to load (overrides `url`).
    pub html: Option<String>,
    /// The window title (`"bunframe"` when `None`).
    pub title: Option<String>,
    /// The window width (logical px; `1024` when `None`).
    pub width: Option<u32>,
    /// The window height (logical px; `768` when `None`).
    pub height: Option<u32>,
    /// The minimum width (logical px).
    pub min_width: Option<u32>,
    /// The minimum height (logical px).
    pub min_height: Option<u32>,
    /// Whether the window is resizable (`true` when `None`).
    pub resizable: Option<bool>,
    /// Whether the window has decorations (`true` when `None`).
    pub decorations: Option<bool>,
    /// Whether the window/webview background is transparent.
    pub transparent: Option<bool>,
    /// Whether the window opens maximized.
    pub maximized: Option<bool>,
    /// Whether the window is visible on creation (`true` when
    /// `None`).
    pub visible: Option<bool>,
    /// The window position, logical x.
    pub x: Option<u32>,
    /// The window position, logical y.
    pub y: Option<u32>,
    /// Whether devtools are enabled.
    pub devtools: Option<bool>,
    /// Whether the window is always on top.
    pub always_on_top: Option<bool>,
    /// Whether the window is hidden from the taskbar (Windows).
    pub skip_taskbar: Option<bool>,
    /// The asset directory served to this window through the `bf`
    /// custom protocol (set at creation; wry binds custom protocols
    /// at webview build time). The page loads `bf://localhost/<rel
    /// -path>` - wry maps it to `http://bf.localhost/<rel-path>` on
    /// Windows, so the page sees `http://bf.localhost/...` origins:
    /// spell URLs `bf://localhost/...` in app code. `/` serves
    /// `index.html`.
    pub asset_root: Option<String>,
}

impl WindowConfig {
    /// The window size with the fallbacks applied (`1024x768`
    /// when both fields are `None`).
    pub fn effective_size(&self) -> (u32, u32) {
        (
            self.width.unwrap_or(DEFAULT_WIDTH),
            self.height.unwrap_or(DEFAULT_HEIGHT),
        )
    }

    /// The window title with the fallback applied.
    pub fn effective_title(&self) -> String {
        self.title
            .clone()
            .unwrap_or_else(|| DEFAULT_TITLE.to_owned())
    }
}

/// The inner (webview viewport) size of a window, in PHYSICAL
/// pixels (the [`window_inner_size`] reply).
#[derive(BffiRecord, Clone, Copy, Debug, PartialEq)]
pub struct WindowSize {
    /// Width, physical pixels.
    pub width: u32,
    /// Height, physical pixels.
    pub height: u32,
}

/// The outer-frame position of a window, in PHYSICAL pixels (the
/// [`window_position`] reply).
#[derive(BffiRecord, Clone, Copy, Debug, PartialEq)]
pub struct WindowPosition {
    /// X, physical pixels.
    pub x: i32,
    /// Y, physical pixels.
    pub y: i32,
}

/// The registry slot behind a window handle: the IPC binding
/// ([`window_bind_ipc`]), the close-veto callback
/// ([`window_bind_close`]) and the events stream created with the
/// window.
#[derive(Default)]
struct WindowSlot {
    ipc: Mutex<Option<u64>>,
    close_veto: Mutex<Option<u64>>,
    events: Mutex<Option<Ctx<String>>>,
    events_handle: Mutex<Option<u64>>,
    /// The queue into the window's IPC worker (`None` = no worker
    /// yet - the first [`window_bind_ipc`] spawns it; dropped by
    /// [`close_window`] so the worker exits promptly).
    ipc_tx: Mutex<Option<Sender<String>>>,
}

/// A live registry slot behind a raw window handle.
fn window_slot(handle: u64) -> Result<Arc<WindowSlot>, BunframeError> {
    Registry::global()
        .get_typed::<WindowSlot>(Handle::from_raw(handle))
        .ok_or(BunframeError::InvalidHandle)
}

/// The close-veto callback handle of a window slot, if any.
fn bound_veto(handle: u64) -> Option<u64> {
    let slot = window_slot(handle).ok()?;
    let binding = slot
        .close_veto
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    *binding
}

/// Pushes one event JSON onto the window's events stream (ON the
/// loop thread; blocks with backpressure while the buffer is full).
/// A gone consumer (the stream completed or dropped) silently
/// discards the event.
fn push_event(handle: u64, event_json: &str) {
    let Some(slot) = window_slot(handle).ok() else {
        return;
    };
    let guard = slot.events.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(ctx) = guard.as_ref() {
        let _ = block_on(ctx.push(event_json.to_owned()));
    }
}

/// Completes the events stream of a window (before the slot drops:
/// the JS side sees the stream end).
fn complete_events(handle: u64) {
    let Some(slot) = window_slot(handle).ok() else {
        return;
    };
    if let Some(ctx) = slot
        .events
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
    {
        let _ = ctx.complete();
    }
}

/// The per-window IPC message box: the reply written back by the
/// JS callback ([`window_ipc_reply`]). The request body crosses the
/// callback boundary itself (`Value::Str`); only the reply rides
/// the box.
#[derive(Default)]
struct IpcBox {
    reply: Option<String>,
}

static IPC_BOXES: LazyLock<Mutex<HashMap<u64, IpcBox>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn with_boxes<R>(f: impl FnOnce(&mut HashMap<u64, IpcBox>) -> R) -> R {
    let mut boxes = IPC_BOXES.lock().unwrap_or_else(PoisonError::into_inner);
    f(&mut boxes)
}

/// Stores the reply computed by the JS callback.
fn ipc_put_reply(handle: u64, body: String) {
    with_boxes(|boxes| boxes.entry(handle).or_default().reply = Some(body));
}

/// Takes the stored reply (one-shot) on the loop thread.
fn ipc_take_reply(handle: u64) -> Option<String> {
    with_boxes(|boxes| boxes.get_mut(&handle).and_then(|entry| entry.reply.take()))
}

/// A window operation, proxied onto the loop thread. Applying is a
/// plain method call on the winit `Window` (or the wry webview for
/// the devtools).
#[derive(Clone, Debug)]
enum WindowOp {
    SetTitle(String),
    SetSize(u32, u32),
    SetPosition(i32, i32),
    Center,
    SetMinSize(u32, u32),
    SetResizable(bool),
    SetDecorations(bool),
    SetAlwaysOnTop(bool),
    SetVisible(bool),
    Focus,
    Maximize,
    Unmaximize,
    Minimize,
    OpenDevtools,
}

impl WindowOp {
    fn apply(&self, entry: &WryWindow) {
        let window = &entry.window;
        match self {
            Self::SetTitle(title) => window.set_title(title),
            Self::SetSize(width, height) => {
                let _ = window
                    .request_inner_size(LogicalSize::new(f64::from(*width), f64::from(*height)));
            }
            Self::SetPosition(x, y) => {
                // LOGICAL pixels, matching the x/y of the open
                // config.
                window.set_outer_position(LogicalPosition::new(f64::from(*x), f64::from(*y)));
            }
            Self::Center => {
                // Best-effort by design: `apply` ignores errors, so
                // a window without a monitor simply stays put. The
                // math is manual (winit 0.30 has no `Window::center`)
                // and PHYSICAL: monitor origin + half the free area.
                let Some(monitor) = window.current_monitor() else {
                    return;
                };
                let monitor_pos = monitor.position();
                let monitor_size = monitor.size();
                let window_size = window.outer_size();
                window.set_outer_position(PhysicalPosition::new(
                    monitor_pos.x + (monitor_size.width as i32 - window_size.width as i32) / 2,
                    monitor_pos.y + (monitor_size.height as i32 - window_size.height as i32) / 2,
                ));
            }
            Self::SetMinSize(width, height) => {
                // 0/0 clears the constraint (the ABI has no Option
                // params); anything else clamps up to at least 1x1.
                if *width == 0 && *height == 0 {
                    window.set_min_inner_size::<LogicalSize<f64>>(None);
                } else {
                    window.set_min_inner_size(Some(LogicalSize::new(
                        f64::from((*width).max(1)),
                        f64::from((*height).max(1)),
                    )));
                }
            }
            Self::SetResizable(on) => window.set_resizable(*on),
            Self::SetDecorations(on) => window.set_decorations(*on),
            Self::SetAlwaysOnTop(on) => window.set_window_level(if *on {
                WindowLevel::AlwaysOnTop
            } else {
                WindowLevel::Normal
            }),
            Self::SetVisible(on) => window.set_visible(*on),
            Self::Focus => window.focus_window(),
            Self::Maximize => window.set_maximized(true),
            Self::Unmaximize => window.set_maximized(false),
            Self::Minimize => window.set_minimized(true),
            Self::OpenDevtools => entry.webview.open_devtools(),
        }
    }
}

/// A loop-thread query: read-only window state, answered inline on
/// the loop thread.
enum QueryOp {
    IsMaximized,
    IsVisible,
    InnerSize,
    Position,
}

/// The answer to one [`QueryOp`].
enum QueryReply {
    Flag(bool),
    Size { width: u32, height: u32 },
    Position { x: i32, y: i32 },
}

impl QueryReply {
    /// The bool of a `Flag` reply (type-checked unwrap).
    fn into_flag(self) -> Result<bool, BunframeError> {
        match self {
            Self::Flag(flag) => Ok(flag),
            _ => Err(unexpected_query_reply()),
        }
    }

    /// The size of a `Size` reply (type-checked unwrap).
    fn into_size(self) -> Result<WindowSize, BunframeError> {
        match self {
            Self::Size { width, height } => Ok(WindowSize { width, height }),
            _ => Err(unexpected_query_reply()),
        }
    }

    /// The position of a `Position` reply (type-checked unwrap).
    fn into_position(self) -> Result<WindowPosition, BunframeError> {
        match self {
            Self::Position { x, y } => Ok(WindowPosition { x, y }),
            _ => Err(unexpected_query_reply()),
        }
    }
}

fn unexpected_query_reply() -> BunframeError {
    BunframeError::OperationFailed {
        message: "the loop thread answered with the wrong query shape".to_owned(),
    }
}

/// A command for the loop thread, delivered through the event-loop
/// proxy (`send_event` is the only legal cross-thread door into the
/// winit loop).
enum Command {
    /// Create a window + webview per the config.
    Create {
        config: WindowConfig,
        reply: Sender<Result<u64, String>>,
    },
    /// Evaluate a script in the webview behind `handle`.
    Eval { handle: u64, js: String },
    /// Drop the webview behind `handle`; exit the loop when the
    /// last one goes.
    Close { handle: u64 },
    /// Apply one window operation.
    Op { handle: u64, op: WindowOp },
    /// Read one piece of window state; the loop thread answers the
    /// channel inline.
    Query {
        handle: u64,
        op: QueryOp,
        reply: Sender<Result<QueryReply, String>>,
    },
    /// Exit the loop thread (the explicit quit).
    Quit,
}

/// The proxy of the RUNNING loop thread (`None` = not running).
static LOOP_PROXY: Mutex<Option<EventLoopProxy<Command>>> = Mutex::new(None);
/// Wakes [`ensure_loop`] when the proxy appears (or the startup
/// fails).
static LOOP_PROXY_SIGNAL: Condvar = Condvar::new();
/// The startup failure of the last spawn attempt (cleared on every
/// new spawn).
static LOOP_START_ERROR: Mutex<Option<String>> = Mutex::new(None);
/// Sticky "the loop thread has finished" flag
/// ([`window_poll_exit`]).
static LOOP_EXITED: AtomicBool = AtomicBool::new(false);

fn lock_proxy() -> MutexGuard<'static, Option<EventLoopProxy<Command>>> {
    LOOP_PROXY.lock().unwrap_or_else(PoisonError::into_inner)
}

fn lock_start_error() -> MutexGuard<'static, Option<String>> {
    LOOP_START_ERROR
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// The proxy of a RUNNING loop thread; never spawns one.
fn loop_proxy() -> Result<EventLoopProxy<Command>, BunframeError> {
    lock_proxy().clone().ok_or(BunframeError::LoopNotRunning)
}

/// The proxy of a loop thread, spawning one if necessary. The JS
/// caller waits (bounded) for the loop thread to publish its proxy.
fn ensure_loop() -> Result<EventLoopProxy<Command>, BunframeError> {
    // A quit loop never respawns: winit 0.30 allows exactly ONE
    // EventLoop per process, so after [`app_quit`] the shell is
    // done.
    if LOOP_EXITED.load(Ordering::Acquire) {
        return Err(BunframeError::LoopNotRunning);
    }
    let mut guard = lock_proxy();
    if guard.is_none() {
        spawn_loop_thread()?;
        let deadline = Instant::now() + LOOP_START_TIMEOUT;
        while guard.is_none() {
            let now = Instant::now();
            if now >= deadline {
                return Err(BunframeError::LoopNotRunning);
            }
            if let Some(message) = lock_start_error().clone() {
                return Err(BunframeError::CreateFailed { message });
            }
            let (woken, _) = LOOP_PROXY_SIGNAL
                .wait_timeout(guard, deadline - now)
                .unwrap_or_else(PoisonError::into_inner);
            guard = woken;
        }
    }
    guard.clone().ok_or(BunframeError::LoopNotRunning)
}

fn spawn_loop_thread() -> Result<(), BunframeError> {
    *lock_start_error() = None;
    std::thread::Builder::new()
        .name("bunframe-loop".to_owned())
        .spawn(loop_thread_body)
        .map_err(|error| BunframeError::CreateFailed {
            message: format!("spawning the loop thread failed: {error}"),
        })?;
    Ok(())
}

/// Publishes the loop-not-running state no matter HOW the thread
/// body ends (a panic unwinds through here too).
struct LoopGuard;

impl Drop for LoopGuard {
    fn drop(&mut self) {
        *lock_proxy() = None;
        LOOP_PROXY_SIGNAL.notify_all();
        LOOP_EXITED.store(true, Ordering::Release);
    }
}

fn loop_thread_body() {
    let _guard = LoopGuard;
    let mut builder = EventLoop::<Command>::with_user_event();
    // The OS main thread belongs to the Bun host process, so the
    // event loop must be allowed on this spawned thread (Windows
    // gate; other platforms keep their default restriction).
    #[cfg(windows)]
    builder.with_any_thread(true);
    let event_loop = match builder.build() {
        Ok(event_loop) => event_loop,
        Err(error) => {
            *lock_start_error() = Some(format!("the winit event loop failed to build: {error}"));
            LOOP_PROXY_SIGNAL.notify_all();
            return;
        }
    };
    *lock_proxy() = Some(event_loop.create_proxy());
    LOOP_PROXY_SIGNAL.notify_all();

    let mut app = LoopApp::default();
    // Runs until the last webview closes (then `exit()`); an error
    // return leaves the LoopGuard to publish the shutdown.
    let _ = event_loop.run_app(&mut app);
}

/// One open window: the wry surface plus its host window. Field
/// order matters - the webview (the child) must drop before the
/// window (its parent).
struct WryWindow {
    webview: WebView,
    window: Window,
}

/// The winit handler: everything the JS exports proxy lands here,
/// ON the loop thread.
#[derive(Default)]
struct LoopApp {
    windows: HashMap<u64, WryWindow>,
}

impl ApplicationHandler<Command> for LoopApp {
    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}

    fn user_event(&mut self, event_loop: &ActiveEventLoop, command: Command) {
        match command {
            Command::Create { config, reply } => {
                let _ = reply.send(create_window(self, event_loop, config));
            }
            Command::Eval { handle, js } => {
                if let Some(entry) = self.windows.get(&handle) {
                    let _ = entry.webview.evaluate_script(&js);
                }
            }
            Command::Close { handle } => close_window(self, handle),
            Command::Quit => event_loop.exit(),
            Command::Op { handle, op } => {
                if let Some(entry) = self.windows.get(&handle) {
                    op.apply(entry);
                }
            }
            Command::Query { handle, op, reply } => {
                let outcome = match self.windows.get(&handle) {
                    Some(entry) => run_query(entry, op),
                    None => Err("unknown window".to_owned()),
                };
                let _ = reply.send(outcome);
            }
        }
    }

    fn window_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        let handle = self
            .windows
            .iter()
            .find(|(_, entry)| entry.window.id() == window_id)
            .map(|(handle, _)| *handle);
        let Some(handle) = handle else {
            return;
        };
        match event {
            WindowEvent::CloseRequested => {
                // The veto check parks the loop thread while the JS
                // thread pumps (the same roundtrip mechanics as the
                // IPC bridge). Fail-open: any error allows the
                // close.
                run_close_requested(handle);
            }
            WindowEvent::Resized(size) => {
                push_event(
                    handle,
                    &format!(
                        r#"{{"type":"resized","width":{},"height":{}}}"#,
                        size.width, size.height
                    ),
                );
            }
            WindowEvent::Focused(focused) => {
                push_event(
                    handle,
                    &format!(r#"{{"type":"focused","focused":{focused}}}"#),
                );
            }
            _ => {}
        }
    }
}

/// Reads one piece of window state (ON the loop thread; the winit
/// `Window` is only sound here).
fn run_query(entry: &WryWindow, op: QueryOp) -> Result<QueryReply, String> {
    let window = &entry.window;
    match op {
        QueryOp::IsMaximized => Ok(QueryReply::Flag(window.is_maximized())),
        QueryOp::IsVisible => Ok(QueryReply::Flag(window.is_visible().unwrap_or(false))),
        QueryOp::InnerSize => {
            let size = window.inner_size();
            Ok(QueryReply::Size {
                width: size.width,
                height: size.height,
            })
        }
        QueryOp::Position => window.outer_position().map_or_else(
            |error| Err(format!("reading the window position failed: {error}")),
            |position| {
                Ok(QueryReply::Position {
                    x: position.x,
                    y: position.y,
                })
            },
        ),
    }
}

/// Creates the window + webview for one `Create` command (ON the
/// loop thread; both are unusable from anywhere else). Also opens
/// the window's events stream.
fn create_window(
    app: &mut LoopApp,
    event_loop: &ActiveEventLoop,
    config: WindowConfig,
) -> Result<u64, String> {
    let _ = Registry::global().declare::<WindowSlot>(WINDOW_TAG);

    let (width, height) = config.effective_size();
    let mut attributes = Window::default_attributes()
        .with_title(config.effective_title())
        .with_inner_size(LogicalSize::new(width, height))
        .with_resizable(config.resizable.unwrap_or(true))
        .with_decorations(config.decorations.unwrap_or(true))
        .with_transparent(config.transparent.unwrap_or(false))
        .with_maximized(config.maximized.unwrap_or(false))
        .with_visible(config.visible.unwrap_or(true))
        .with_window_level(if config.always_on_top.unwrap_or(false) {
            WindowLevel::AlwaysOnTop
        } else {
            WindowLevel::Normal
        });
    if let Some(min_width) = config.min_width {
        attributes = attributes.with_min_inner_size(LogicalSize::new(f64::from(min_width), 0.0));
    }
    if let Some(min_height) = config.min_height {
        attributes = attributes.with_min_inner_size(LogicalSize::new(0.0, f64::from(min_height)));
    }
    if let (Some(x), Some(y)) = (config.x, config.y) {
        attributes = attributes.with_position(LogicalPosition::new(f64::from(x), f64::from(y)));
    }
    #[cfg(windows)]
    if config.skip_taskbar.unwrap_or(false) {
        attributes = attributes.with_skip_taskbar(true);
    }
    let window = event_loop
        .create_window(attributes)
        .map_err(|error| format!("window creation failed: {error}"))?;

    let handle = Registry::global()
        .insert(WINDOW_TAG, Arc::new(WindowSlot::default()))
        .map_err(|error| format!("registry insert failed: {error}"))?;
    let raw = handle.as_u64();

    // The events stream of this window: JSON strings, backpressured.
    let (events_handle, events_ctx) =
        spawn_push::<String>().map_err(|error| format!("events stream spawn failed: {error}"))?;
    {
        let slot = Registry::global()
            .get_typed::<WindowSlot>(handle)
            .ok_or_else(|| "the freshly created slot is gone".to_owned())?;
        *slot.events.lock().unwrap_or_else(PoisonError::into_inner) = Some(events_ctx);
        *slot
            .events_handle
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(events_handle.as_u64());
    }

    let mut builder = WebViewBuilder::new()
        .with_devtools(config.devtools.unwrap_or(false))
        .with_transparent(config.transparent.unwrap_or(false));
    // Custom protocols bind ONLY at webview build time, so the
    // asset root is a creation-time decision. The root must exist:
    // canonicalize it here and serve from the canonical path (the
    // traversal checks inside `serve_asset` rely on that).
    if let Some(root) = &config.asset_root {
        let canonical = std::fs::canonicalize(root)
            .map_err(|error| format!("asset root {root:?} not found: {error}"))?;
        builder = builder.with_custom_protocol("bf".to_owned(), move |_id, request| {
            serve_asset(&canonical, &request)
        });
    }
    builder = builder.with_ipc_handler(move |request: http::Request<String>| {
        handle_ipc(raw, request.into_body());
    });
    if let Some(url) = config.url {
        builder = builder.with_url(url);
    }
    if let Some(html) = config.html {
        builder = builder.with_html(html);
    }
    builder = builder.with_initialization_script(IPC_BOOTSTRAP);

    match builder.build(&window) {
        Ok(webview) => {
            app.windows.insert(raw, WryWindow { webview, window });
            Ok(raw)
        }
        Err(error) => {
            let _ = Registry::global().remove(handle);
            Err(format!("webview creation failed: {error}"))
        }
    }
}

/// Drops one window: pushes a `closed` event, completes its events
/// stream, and removes the registry slot. The loop thread STAYS
/// alive (winit 0.30 allows one EventLoop per process; the exit is
/// explicit via [`app_quit`]).
fn close_window(app: &mut LoopApp, handle: u64) {
    if app.windows.remove(&handle).is_some() {
        push_event(handle, r#"{"type":"closed"}"#);
        complete_events(handle);
        // Close the IPC worker's channel BEFORE the slot leaves the
        // registry: the worker exits on its next recv (promptly,
        // not at process teardown) even though it still holds an
        // Arc of the slot.
        if let Ok(slot) = window_slot(handle) {
            *slot.ipc_tx.lock().unwrap_or_else(PoisonError::into_inner) = None;
        }
        let _ = Registry::global().remove(Handle::from_raw(handle));
    }
}

/// Serves one `bf://localhost/<rel-path>` request from the window's
/// canonical asset root. Defense in depth: any `..` segment is a
/// 403 before the filesystem is touched, and the canonicalized file
/// path must stay inside the canonical root. Never panics (a broken
/// builder falls back to a plain error response).
fn serve_asset(root: &Path, request: &http::Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    // The page spells `bf://localhost/<path>`; the handler sees the
    // reverted URI.
    let full = request.uri().to_string();
    let Some(rest) = full
        .strip_prefix("bf://localhost/")
        .or_else(|| full.strip_prefix("http://bf.localhost/"))
    else {
        return plain_response(StatusCode::NOT_FOUND, "not found");
    };
    // Strip any query/fragment, then default the document root.
    let mut rel = rest.split(['?', '#']).next().unwrap_or("").to_owned();
    if rel.is_empty() || rel.ends_with('/') {
        rel.push_str("index.html");
    }
    if rel.split('/').any(|segment| segment == "..") {
        return plain_response(StatusCode::FORBIDDEN, "forbidden");
    }
    let Ok(path) = std::fs::canonicalize(root.join(&rel)) else {
        return plain_response(StatusCode::NOT_FOUND, "not found");
    };
    if !path.starts_with(root) {
        return plain_response(StatusCode::FORBIDDEN, "forbidden");
    }
    if path.is_dir() {
        return plain_response(StatusCode::NOT_FOUND, "not found");
    }
    match std::fs::read(&path) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", asset_content_type(&rel))
            .body(Cow::Owned(bytes))
            .unwrap_or_else(|_| Response::new(Cow::Owned(Vec::new()))),
        Err(_) => plain_response(StatusCode::NOT_FOUND, "not found"),
    }
}

/// The minimal error response of the asset protocol (plain text;
/// the page only cares about the status code).
fn plain_response(status: StatusCode, text: &'static str) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain")
        .body(Cow::Borrowed(text.as_bytes()))
        .unwrap_or_else(|_| Response::new(Cow::Borrowed(&b"error"[..])))
}

/// The Content-Type for a served asset, from its extension.
fn asset_content_type(path: &str) -> &'static str {
    let extension = path.rsplit('.').next().unwrap_or("");
    match extension {
        "html" | "htm" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// The wry ipc handler ON the loop thread: hands the request body
/// to the window's IPC worker and returns immediately - the loop
/// thread never parks here (the worker owns the roundtrip). With
/// nothing bound (no worker yet) the message is dropped.
fn handle_ipc(slot: u64, body: String) {
    let Ok(entry) = window_slot(slot) else {
        return;
    };
    let tx = entry
        .ipc_tx
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    if let Some(tx) = tx {
        let _ = tx.send(body);
    }
}

/// Makes sure the window's IPC worker thread exists: it owns the
/// receiving side of the ipc queue and drains into the loop thread
/// (resolve scripts ride `Command::Eval`). The first
/// [`window_bind_ipc`] spawns it; rebinding keeps the worker and
/// just swaps the callback handle (read fresh every message).
fn ensure_ipc_worker(handle: u64, slot: &Arc<WindowSlot>) -> Result<(), BunframeError> {
    {
        let tx = slot.ipc_tx.lock().unwrap_or_else(PoisonError::into_inner);
        if tx.is_some() {
            return Ok(());
        }
    }
    let proxy = loop_proxy()?;
    let (sender, receiver) = channel::<String>();
    let worker_slot = Arc::clone(slot);
    *slot.ipc_tx.lock().unwrap_or_else(PoisonError::into_inner) = Some(sender);
    std::thread::Builder::new()
        .name(format!("bunframe-ipc-{handle}"))
        .spawn(move || ipc_worker(handle, worker_slot, receiver, proxy))
        .map_err(|error| {
            // The channel died with the spawn failure: reset so a
            // retry can spawn a fresh worker.
            if let Ok(slot) = window_slot(handle) {
                *slot.ipc_tx.lock().unwrap_or_else(PoisonError::into_inner) = None;
            }
            BunframeError::CreateFailed {
                message: format!("spawning the ipc worker failed: {error}"),
            }
        })?;
    Ok(())
}

/// The per-window IPC worker: pulls queued page messages, invokes
/// the bound JS callback (the Bun thread pumps meanwhile) and
/// queues the settle script back through the loop thread. Exits
/// when the queue closes ([`close_window`] drops the sender).
fn ipc_worker(
    handle: u64,
    slot: Arc<WindowSlot>,
    receiver: Receiver<String>,
    proxy: EventLoopProxy<Command>,
) {
    while let Ok(body) = receiver.recv() {
        let bound = *slot.ipc.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(ipc) = bound else {
            // Nothing bound right now: drop the message instead of
            // stalling a guaranteed timeout.
            continue;
        };
        let outcome = invoke_wait(
            Handle::from_raw(ipc),
            &[Value::Str(body.clone())],
            IPC_TIMEOUT,
        );
        let script = match outcome {
            Ok(_) => match ipc_take_reply(handle) {
                Some(reply) => format!("window.__bffiResolve({reply});"),
                None => "window.__bffiResolve(null);".to_owned(),
            },
            Err(error) => resolve_error_script(&body, &error.to_string()),
        };
        let _ = proxy.send_event(Command::Eval { handle, js: script });
    }
}

/// Escapes `text` for embedding inside a double-quoted JS string.
fn escape_js(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other => out.push(other),
        }
    }
    out
}

/// The failure settle script: routes the error to the pending
/// promise by request `id` (best-effort; `null` when the body has
/// no parsable id). Never panics - a broken page body must not take
/// down the IPC worker.
fn resolve_error_script(body: &str, message: &str) -> String {
    let id_json = match extract_request_id(body) {
        Some(id) => format!("\"{}\"", escape_js(&id)),
        None => "null".to_owned(),
    };
    format!(
        "window.__bffiResolve({{\"v\":1,\"id\":{id_json},\"ok\":false,\"error\":{{\"code\":\"NATIVE\",\"message\":\"{}\"}}}});",
        escape_js(message)
    )
}

/// Best-effort `"id":"<value>"` scan of an IPC request body (our
/// own envelope; the crate carries no JSON dependency).
fn extract_request_id(body: &str) -> Option<String> {
    let key = body.find("\"id\"")?;
    let after_key = &body[key + "\"id\"".len()..];
    let open = after_key.find('"')?;
    let after_open = &after_key[open + 1..];
    let close = after_open.find('"')?;
    Some(after_open[..close].to_owned())
}

/// The CloseRequested path (the title-bar X, and the test export):
/// consults the close-veto callback when one is bound
/// (`invoke_wait`; the callback returns `true` to ALLOW the close,
/// `false` to deny - fail-open on error/timeout), then closes or
/// pushes a `close-denied` event. On the loop thread this parks
/// inline; from the test export it runs on a spawned thread.
fn run_close_requested(handle: u64) {
    let allow = match bound_veto(handle) {
        None => true,
        Some(veto) => {
            match invoke_wait(
                Handle::from_raw(veto),
                &[Value::Str(r#"{"type":"close-requested"}"#.to_owned())],
                VETO_TIMEOUT,
            ) {
                Ok(Value::Bool(allow)) => allow,
                _ => true,
            }
        }
    };
    if allow {
        if let Ok(proxy) = loop_proxy() {
            let _ = proxy.send_event(Command::Close { handle });
        }
    } else {
        push_event(handle, r#"{"type":"close-denied"}"#);
    }
}

/// Injected into every page: the promise bridge the UI code uses.
/// Calls carry an `id` and settle id-routed through
/// `window.__bffiResolve(payload)` - so calls PIPELINE (no
/// single-flight guard) and a call never rejects on its own: the
/// native 30s timeout settles every call with an error envelope,
/// and requests serialize per window through the worker thread.
/// `__bffiEvent` posts `kind: "evt"` frames (page -> bun
/// fire-and-forget messages; the bun side acks with `ok: null`).
/// `__bfDispatch`/`__bfOn` are the backend-to-page message door:
/// frames posted while no listener is registered stay buffered
/// until the first `__bfOn` (which drains the buffer first).
const IPC_BOOTSTRAP: &str = r#"window.__bfPending = new Map();
window.__bfId = () => (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + "-" + Math.random());
window.__bffiCall = (method, args) => new Promise((resolve) => {
  const id = window.__bfId();
  window.__bfPending.set(id, { resolve });
  window.ipc.postMessage(JSON.stringify({ v: 1, id, kind: "req", method, args }));
});
window.__bffiEvent = (method, args) => new Promise((resolve) => {
  const id = window.__bfId();
  window.__bfPending.set(id, { resolve });
  window.ipc.postMessage(JSON.stringify({ v: 1, id, kind: "evt", method, args }));
});
window.__bffiResolve = (payload) => {
  if (payload && typeof payload === "object" && payload.id != null) {
    const p = window.__bfPending.get(payload.id);
    if (p) { window.__bfPending.delete(payload.id); p.resolve(payload); }
  }
};
window.__bfBuffer = [];
window.__bfListeners = [];
window.__bfDispatch = (frame) => {
  if (window.__bfListeners.length) { for (const l of window.__bfListeners.splice(0)) { try { l(frame); } catch {} } }
  else { window.__bfBuffer.push(frame); }
};
window.__bfOn = (handler) => {
  const buffered = window.__bfBuffer.splice(0);
  for (const f of buffered) { try { handler(f); } catch {} }
  window.__bfListeners.push(handler);
  return () => { const i = window.__bfListeners.indexOf(handler); if (i >= 0) window.__bfListeners.splice(i, 1); };
};"#;

/// Validates the slot handle and returns it (the shared guard of
/// the JS-facing window fns).
fn live_slot(handle: u64) -> Result<(), BunframeError> {
    window_slot(handle).map(|_| ())
}

/// Validates the slot and proxies one window operation onto the
/// loop thread.
fn send_op(handle: u64, op: WindowOp) -> Result<(), BunframeError> {
    live_slot(handle)?;
    loop_proxy()?
        .send_event(Command::Op { handle, op })
        .map_err(|_| BunframeError::LoopNotRunning)
}

/// Validates the slot and runs one read-only query: the command
/// round trip mirrors [`window_open`] (validate, proxy, wait
/// bounded for the loop-thread answer). The Bun thread blocks for
/// up to [`QUERY_TIMEOUT`] - no pump involvement (a plain channel,
/// no callback marshalling).
fn query_window(handle: u64, op: QueryOp) -> Result<QueryReply, BunframeError> {
    live_slot(handle)?;
    let proxy = loop_proxy()?;
    let (reply, answer) = channel();
    proxy
        .send_event(Command::Query { handle, op, reply })
        .map_err(|_| BunframeError::LoopNotRunning)?;
    match answer.recv_timeout(QUERY_TIMEOUT) {
        Ok(outcome) => outcome.map_err(|message| BunframeError::OperationFailed { message }),
        Err(_) => Err(BunframeError::OperationFailed {
            message: "the loop thread did not answer the query".to_owned(),
        }),
    }
}

/// Validates a bound callback handle against an exact signature.
fn validate_callback(
    handle: u64,
    ret: bffi::ValueType,
    params: &[bffi::ValueType],
) -> Result<(), BunframeError> {
    if handle == 0 {
        return Err(BunframeError::InvalidCallback {
            message: "the callback handle is null".to_owned(),
        });
    }
    let info = bffi::js_callback(Handle::from_raw(handle)).map_err(|error| {
        BunframeError::InvalidCallback {
            message: format!("invalid callback handle: {error}"),
        }
    })?;
    if info.sig.ret() != ret || info.sig.params() != params {
        return Err(BunframeError::InvalidCallback {
            message: format!(
                "the callback must have the {:?}({}) signature, got {:?}({})",
                ret,
                params
                    .iter()
                    .map(|p| format!("{p:?}"))
                    .collect::<Vec<_>>()
                    .join(", "),
                ret,
                info.sig
                    .params()
                    .iter()
                    .map(|p| format!("{p:?}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        });
    }
    Ok(())
}

/// Opens a window described by `config` (inline `html` or a `url`,
/// title, size, min size, decorations, transparency, position,
/// maximized/visible/always-on-top/skip-taskbar, devtools, `bf`
/// asset serving) and returns its opaque handle. The first call
/// spawns the dedicated loop thread (winit event loop + window +
/// wry surface live there); the Bun thread only waits, bounded, for
/// the creation reply. The window's events stream opens with the
/// window - pull it through [`window_events`].
#[bffi]
pub fn window_open(config: WindowConfig) -> Result<u64, BunframeError> {
    let proxy = ensure_loop()?;
    let (reply, answer) = channel();
    proxy
        .send_event(Command::Create { config, reply })
        .map_err(|_| BunframeError::LoopNotRunning)?;
    match answer.recv_timeout(CREATE_TIMEOUT) {
        Ok(created) => created.map_err(|message| BunframeError::CreateFailed { message }),
        Err(_) => Err(BunframeError::CreateFailed {
            message: "the loop thread did not answer the create request".to_owned(),
        }),
    }
}

/// The handle of the window's events stream: JSON events
/// (`resized` / `focused` / `close-denied` / `closed`) pulled
/// through the stream API. The stream exists from window creation
/// and completes when the window closes.
#[bffi]
pub fn window_events(handle: u64) -> Result<u64, BunframeError> {
    let slot = window_slot(handle)?;
    let events = slot
        .events_handle
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    events.ok_or(BunframeError::EventsUnavailable)
}

/// Evaluates `js` in the window behind `handle` (proxied onto the
/// loop thread; fire-and-forget - the script's result stays in the
/// page).
#[bffi]
pub fn window_eval(handle: u64, js: &str) -> Result<(), BunframeError> {
    live_slot(handle)?;
    loop_proxy()?
        .send_event(Command::Eval {
            handle,
            js: js.to_owned(),
        })
        .map_err(|_| BunframeError::LoopNotRunning)
}

/// Closes the window behind `handle` (also the title-bar X path,
/// minus the veto): the loop thread drops the window and exits when
/// it was the last one - then [`window_poll_exit`] flips to `true`.
/// The close-veto callback (when bound) is NOT consulted on this
/// programmatic close.
#[bffi]
pub fn window_close(handle: u64) -> Result<(), BunframeError> {
    live_slot(handle)?;
    loop_proxy()?
        .send_event(Command::Close { handle })
        .map_err(|_| BunframeError::LoopNotRunning)
}

/// Sets the window title.
#[bffi]
pub fn window_set_title(handle: u64, title: &str) -> Result<(), BunframeError> {
    send_op(handle, WindowOp::SetTitle(title.to_owned()))
}

/// Sets the window size (logical pixels).
#[bffi]
pub fn window_set_size(handle: u64, width: u32, height: u32) -> Result<(), BunframeError> {
    send_op(handle, WindowOp::SetSize(width, height))
}

/// Sets the window position (logical pixels - the same space as the
/// `x`/`y` open config).
#[bffi]
pub fn window_set_position(handle: u64, x: i32, y: i32) -> Result<(), BunframeError> {
    send_op(handle, WindowOp::SetPosition(x, y))
}

/// Centers the window on its current monitor. Best-effort: window
/// ops are fire-and-forget, so a window without a monitor simply
/// stays put (the center math is PHYSICAL and manual - winit 0.30
/// has no `Window::center`).
#[bffi]
pub fn window_center(handle: u64) -> Result<(), BunframeError> {
    send_op(handle, WindowOp::Center)
}

/// Sets the minimum window size (logical pixels); `0/0` clears the
/// constraint (the ABI has no Option params), any other pair clamps
/// up to at least 1x1.
#[bffi]
pub fn window_set_min_size(handle: u64, width: u32, height: u32) -> Result<(), BunframeError> {
    send_op(handle, WindowOp::SetMinSize(width, height))
}

/// Sets whether the window is resizable.
#[bffi]
pub fn window_set_resizable(handle: u64, on: bool) -> Result<(), BunframeError> {
    send_op(handle, WindowOp::SetResizable(on))
}

/// Sets whether the window has decorations.
#[bffi]
pub fn window_set_decorations(handle: u64, on: bool) -> Result<(), BunframeError> {
    send_op(handle, WindowOp::SetDecorations(on))
}

/// Sets whether the window is always on top.
#[bffi]
pub fn window_set_always_on_top(handle: u64, on: bool) -> Result<(), BunframeError> {
    send_op(handle, WindowOp::SetAlwaysOnTop(on))
}

/// Shows or hides the window.
#[bffi]
pub fn window_set_visible(handle: u64, on: bool) -> Result<(), BunframeError> {
    send_op(handle, WindowOp::SetVisible(on))
}

/// Gives the window keyboard focus.
#[bffi]
pub fn window_focus(handle: u64) -> Result<(), BunframeError> {
    send_op(handle, WindowOp::Focus)
}

/// Maximizes the window.
#[bffi]
pub fn window_maximize(handle: u64) -> Result<(), BunframeError> {
    send_op(handle, WindowOp::Maximize)
}

/// Restores a maximized window.
#[bffi]
pub fn window_unmaximize(handle: u64) -> Result<(), BunframeError> {
    send_op(handle, WindowOp::Unmaximize)
}

/// Minimizes the window.
#[bffi]
pub fn window_minimize(handle: u64) -> Result<(), BunframeError> {
    send_op(handle, WindowOp::Minimize)
}

/// Whether the window behind `handle` is currently maximized
/// (queried on the loop thread; the Bun thread waits, bounded, for
/// the answer).
#[bffi]
pub fn window_is_maximized(handle: u64) -> Result<bool, BunframeError> {
    query_window(handle, QueryOp::IsMaximized)?.into_flag()
}

/// Whether the window behind `handle` is currently visible.
#[bffi]
pub fn window_is_visible(handle: u64) -> Result<bool, BunframeError> {
    query_window(handle, QueryOp::IsVisible)?.into_flag()
}

/// The inner (webview viewport) size of the window behind
/// `handle`, in PHYSICAL pixels.
#[bffi]
pub fn window_inner_size(handle: u64) -> Result<WindowSize, BunframeError> {
    query_window(handle, QueryOp::InnerSize)?.into_size()
}

/// The outer-frame position of the window behind `handle`, in
/// PHYSICAL pixels.
#[bffi]
pub fn window_position(handle: u64) -> Result<WindowPosition, BunframeError> {
    query_window(handle, QueryOp::Position)?.into_position()
}

/// Opens the webview devtools of the window.
#[bffi]
pub fn window_open_devtools(handle: u64) -> Result<(), BunframeError> {
    send_op(handle, WindowOp::OpenDevtools)
}

/// Wires the IPC roundtrip of the window behind `handle` to a JS
/// handler: `ipc` is a JS-BOUND callback handle with the signature
/// `unit(str)` - the request body arrives as the `cstring`
/// argument; the handler answers through [`window_ipc_reply`].
///
/// The first bind spawns the window's IPC worker thread: page
/// messages queue on it, so the loop thread never parks inside the
/// wry ipc handler and calls can pipeline. Rebinding keeps the
/// worker and just swaps the callback handle (read fresh per
/// message).
#[bffi]
pub fn window_bind_ipc(handle: u64, ipc: u64) -> Result<(), BunframeError> {
    live_slot(handle)?;
    validate_callback(ipc, bffi::ValueType::Unit, &[bffi::ValueType::Str])?;
    let slot = window_slot(handle)?;
    ensure_ipc_worker(handle, &slot)?;
    *slot.ipc.lock().unwrap_or_else(PoisonError::into_inner) = Some(ipc);
    Ok(())
}

/// The IPC message box, JS side: stores the reply JSON (embedded
/// into the resolve script verbatim, so it MUST be valid JSON).
/// Called by the bound callback before it returns.
#[bffi]
pub fn window_ipc_reply(handle: u64, reply: &str) -> Result<(), BunframeError> {
    live_slot(handle)?;
    ipc_put_reply(handle, reply.to_owned());
    Ok(())
}

/// Wires the close-veto check of the window behind `handle` to a JS
/// callback: `veto` is a JS-BOUND callback handle with the
/// signature `bool(str)`. On a title-bar close request the loop
/// thread passes the event JSON and waits (up to 10s): the callback
/// returns `true` to ALLOW the close, `false` to deny it
/// (a `close-denied` event is pushed). Any error or timeout
/// FAILS OPEN (the close proceeds) - a hung backend must not make
/// a window unclosable.
#[bffi]
pub fn window_bind_close(handle: u64, veto: u64) -> Result<(), BunframeError> {
    live_slot(handle)?;
    validate_callback(veto, bffi::ValueType::Bool, &[bffi::ValueType::Str])?;
    let slot = window_slot(handle)?;
    *slot
        .close_veto
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some(veto);
    Ok(())
}

/// Whether the loop thread has finished (after [`app_quit`], or a
/// loop-thread crash).
#[bffi]
pub fn window_poll_exit() -> bool {
    LOOP_EXITED.load(Ordering::Acquire)
}

/// Exits the loop thread explicitly (the app shell decision): the
/// process is done with native windows afterwards - a later
/// [`window_open`] reports `LoopNotRunning`. Idempotent.
#[bffi]
pub fn app_quit() -> Result<(), BunframeError> {
    loop_proxy()?
        .send_event(Command::Quit)
        .map_err(|_| BunframeError::LoopNotRunning)
}

/// The non-blocking drain the JS side calls while native threads
/// wait (`pumpUntil` from the npm side): the marshalled callback
/// invocation executes here, on the bound JS thread.
#[bffi]
pub fn loop_pump() -> u64 {
    pump()
}

/// TEST-ONLY (not in [`module_def`]): simulates a title-bar close
/// request for `handle` - the full veto path runs on a spawned
/// native thread (the loop thread stays free; the JS side pumps),
/// so the automated e2e can exercise the veto round trip without a
/// human clicking the X.
///
/// # Safety contract
///
/// Not unsafe itself; the loop-thread work is contained. Returns
/// `Ok` when the close-request simulation was dispatched.
#[unsafe(no_mangle)]
#[allow(clippy::not_unsafe_ptr_arg_deref)]
#[doc(hidden)]
pub extern "C" fn bffi_test_close_requested(handle: u64) -> u32 {
    if window_slot(handle).is_err() {
        return ErrorCode::InvalidHandle.as_u32();
    }
    match std::thread::Builder::new()
        .name("bunframe-test-close".to_owned())
        .spawn(move || run_close_requested(handle))
    {
        Ok(_) => ErrorCode::Ok.as_u32(),
        Err(error) => {
            let code = ErrorCode::DomainError;
            bffi::set_last_error(BffiError::new(
                code,
                format!("spawning the close-request thread failed: {error}"),
            ));
            code.as_u32()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{
        DEFAULT_HEIGHT, DEFAULT_TITLE, DEFAULT_WIDTH, IpcBox, WINDOW_TAG, WindowConfig, WindowSlot,
        escape_js, extract_request_id, ipc_put_reply, ipc_take_reply, resolve_error_script,
        window_slot,
    };
    use bffi::Registry;

    #[test]
    fn effective_values_fall_back_to_defaults() {
        let mut config = WindowConfig::default();
        assert_eq!(config.effective_size(), (DEFAULT_WIDTH, DEFAULT_HEIGHT));
        assert_eq!(config.effective_title(), DEFAULT_TITLE);
        config.width = Some(800);
        config.title = Some("app".to_owned());
        assert_eq!(config.effective_size(), (800, DEFAULT_HEIGHT));
        assert_eq!(config.effective_title(), "app");
        config.height = Some(600);
        assert_eq!(config.effective_size(), (800, 600));
    }

    #[test]
    fn ipc_box_roundtrips_the_reply() {
        const HANDLE: u64 = 0xA11CE;
        assert_eq!(ipc_take_reply(HANDLE), None);
        ipc_put_reply(HANDLE, r#"{"pong":"ping"}"#.to_owned());
        assert_eq!(
            ipc_take_reply(HANDLE).as_deref(),
            Some(r#"{"pong":"ping"}"#)
        );
        // Take is one-shot: the box is empty again.
        assert_eq!(ipc_take_reply(HANDLE), None);
    }

    #[test]
    fn ipc_boxes_are_isolated_per_handle() {
        const A: u64 = 0xB000;
        const B: u64 = 0xB001;
        ipc_put_reply(A, "a".to_owned());
        ipc_put_reply(B, "b".to_owned());
        assert_eq!(ipc_take_reply(A).as_deref(), Some("a"));
        assert_eq!(ipc_take_reply(B).as_deref(), Some("b"));
    }

    #[test]
    fn escape_js_neutralizes_the_dangerous_bytes() {
        assert_eq!(escape_js("plain"), "plain");
        assert_eq!(escape_js("a\"b"), "a\\\"b");
        assert_eq!(escape_js("a\\b"), "a\\\\b");
        assert_eq!(escape_js("a\nb\rc\td"), "a\\nb\\rc\\td");
    }

    #[test]
    fn extract_request_id_finds_the_envelope_id() {
        assert_eq!(
            extract_request_id(r#"{"v":1,"id":"abc-1","kind":"req"}"#).as_deref(),
            Some("abc-1")
        );
        // The id value is scanned to its closing quote, spaces or
        // not.
        assert_eq!(
            extract_request_id(r#"{"id": "spaced id"}"#).as_deref(),
            Some("spaced id")
        );
    }

    #[test]
    fn extract_request_id_survives_missing_and_malformed_bodies() {
        assert_eq!(extract_request_id(""), None);
        assert_eq!(extract_request_id(r#"{"method":"ping"}"#), None);
        // Unclosed value: no closing quote, no id.
        assert_eq!(extract_request_id(r#"{"id":"unclosed"#), None);
        // Numeric ids are not string-scanned: null fallback.
        assert_eq!(extract_request_id(r#"{"id":42}"#), None);
    }

    #[test]
    fn resolve_error_script_routes_the_error_by_id() {
        assert_eq!(
            resolve_error_script(r#"{"v":1,"id":"x","kind":"req"}"#, "boom"),
            r#"window.__bffiResolve({"v":1,"id":"x","ok":false,"error":{"code":"NATIVE","message":"boom"}});"#
        );
    }

    #[test]
    fn resolve_error_script_falls_back_to_null_id_and_escapes() {
        assert_eq!(
            resolve_error_script("garbage", "a\"b\nc"),
            r#"window.__bffiResolve({"v":1,"id":null,"ok":false,"error":{"code":"NATIVE","message":"a\"b\nc"}});"#
        );
    }

    #[test]
    fn window_slots_live_in_the_registry() {
        let _ = Registry::global().declare::<WindowSlot>(WINDOW_TAG);
        let handle = Registry::global()
            .insert(WINDOW_TAG, Arc::new(WindowSlot::default()))
            .expect("the table has room");
        assert!(window_slot(handle.as_u64()).is_ok());
        assert!(window_slot(0).is_err());
        // After removal the generational handle stays dead even if
        // the slot index is reused.
        let stale = handle.as_u64();
        assert!(Registry::global().remove(handle));
        assert!(window_slot(stale).is_err());
    }

    #[test]
    fn ipc_box_default_is_empty() {
        let entry = IpcBox::default();
        assert_eq!(entry.reply, None);
    }
}
