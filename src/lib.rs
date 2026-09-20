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

use std::collections::HashMap;
use std::sync::mpsc::{Sender, channel};
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
use winit::dpi::{LogicalPosition, LogicalSize};
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
use winit::window::{Window, WindowId, WindowLevel};
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
}

/// A live registry slot behind a raw window handle.
fn window_slot(handle: u64) -> Result<Arc<WindowSlot>, BunframeError> {
    Registry::global()
        .get_typed::<WindowSlot>(Handle::from_raw(handle))
        .ok_or(BunframeError::InvalidHandle)
}

/// The IPC callback handle of a window slot, if any.
fn bound_ipc(handle: u64) -> Option<u64> {
    let slot = window_slot(handle).ok()?;
    let binding = slot.ipc.lock().unwrap_or_else(PoisonError::into_inner);
    *binding
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

    let proxy = loop_proxy().map_err(|error| error.to_string())?;
    let mut builder = WebViewBuilder::new()
        .with_devtools(config.devtools.unwrap_or(false))
        .with_transparent(config.transparent.unwrap_or(false))
        .with_ipc_handler(move |request: wry::http::Request<String>| {
            handle_ipc(raw, request.into_body(), proxy.clone());
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
        let _ = Registry::global().remove(Handle::from_raw(handle));
    }
}

/// The IPC roundtrip ON the loop thread: park until the JS thread
/// answers, then queue the resolve script. The request body crosses
/// the callback boundary itself (`Value::Str` -> the JSCallback's
/// `cstring` argument). Blocking the UI thread for up to
/// [`IPC_TIMEOUT`] is the price of the synchronous roundtrip - the
/// Bun thread pumps meanwhile.
fn handle_ipc(slot: u64, body: String, proxy: EventLoopProxy<Command>) {
    eprintln!("[bunframe-dbg] ipc message on slot {slot}: {body}");
    let bound = bound_ipc(slot);
    eprintln!(
        "[bunframe-dbg] handle_ipc slot {slot} bound={bound:?} body_len={}",
        body.len()
    );
    let Some(ipc) = bound_ipc(slot) else {
        // Nothing bound: drop the message instead of stalling the
        // UI thread for a guaranteed timeout.
        return;
    };
    let outcome = invoke_wait(Handle::from_raw(ipc), &[Value::Str(body)], IPC_TIMEOUT);
    let reply = if outcome.is_ok() {
        ipc_take_reply(slot)
    } else {
        None
    };
    let script = ipc_resolve_script(&outcome, reply);
    let _ = proxy.send_event(Command::Eval {
        handle: slot,
        js: script,
    });
}

/// The script that settles the page-side promise: the reply JSON as
/// a value, `null` without a reply, an `{ "error": ... }` object on
/// the failure paths (timeout, dead handle, stopped loop).
fn ipc_resolve_script(
    outcome: &Result<Value, bffi::CallbackError>,
    reply: Option<String>,
) -> String {
    match (outcome, reply) {
        (Ok(_), Some(reply)) => format!("window.__bffiResolve({reply});"),
        (Ok(_), None) => "window.__bffiResolve(null);".to_owned(),
        (Err(error), _) => format!(
            "window.__bffiResolve({{ \"error\": \"{}\" }});",
            escape_js(&error.to_string())
        ),
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

/// Injected into every page: the tiny promise bridge the UI code
/// uses. The native side resolves through
/// `window.__bffiResolve(json)` with the reply JSON as a VALUE. A
/// call that gets no native answer within 2s rejects - so a page
/// that starts before the JS side bound its ipc callback can retry.
const IPC_BOOTSTRAP: &str = r#"window.__bffiPending = null;
window.__bffiCall = (method, args) => new Promise((resolve, reject) => {
  if (window.__bffiPending !== null) { reject(new Error("a call is already in flight")); return; }
  const pending = { resolve, reject };
  window.__bffiPending = pending;
  window.ipc.postMessage(JSON.stringify({ method, args }));
  setTimeout(() => {
    if (window.__bffiPending === pending) {
      window.__bffiPending = null;
      reject(new Error("no native answer (is the ipc callback bound?)"));
    }
  }, 2000);
});
window.__bffiResolve = (json) => {
  const pending = window.__bffiPending;
  window.__bffiPending = null;
  if (pending !== null) { pending.resolve(json); }
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
/// maximized/visible/always-on-top/skip-taskbar, devtools) and
/// returns its opaque handle. The first call spawns the dedicated
/// loop thread (winit event loop + window + wry surface live
/// there); the Bun thread only waits, bounded, for the creation
/// reply. The window's events stream opens with the window - pull
/// it through [`window_events`].
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

/// Opens the webview devtools of the window.
#[bffi]
pub fn window_open_devtools(handle: u64) -> Result<(), BunframeError> {
    send_op(handle, WindowOp::OpenDevtools)
}

/// Wires the IPC roundtrip of the window behind `handle` to a JS
/// handler: `ipc` is a JS-BOUND callback handle with the signature
/// `unit(str)` - the request body arrives as the `cstring`
/// argument; the handler answers through [`window_ipc_reply`].
#[bffi]
pub fn window_bind_ipc(handle: u64, ipc: u64) -> Result<(), BunframeError> {
    live_slot(handle)?;
    validate_callback(ipc, bffi::ValueType::Unit, &[bffi::ValueType::Str])?;
    let slot = window_slot(handle)?;
    *slot.ipc.lock().unwrap_or_else(PoisonError::into_inner) = Some(ipc);
    eprintln!("[bunframe-dbg] bind_ipc stored slot {handle} ipc {ipc}");
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
        escape_js, ipc_put_reply, ipc_resolve_script, ipc_take_reply, window_slot,
    };
    use bffi::{CallbackError, Registry, Value};

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
    fn resolve_script_embeds_the_reply_or_the_error() {
        let ok = Ok(Value::Bool(true));
        assert_eq!(
            ipc_resolve_script(&ok, Some(r#"{"pong":"ping"}"#.to_owned())),
            r#"window.__bffiResolve({"pong":"ping"});"#
        );
        assert_eq!(ipc_resolve_script(&ok, None), "window.__bffiResolve(null);");
        let error = Err(CallbackError::Timeout);
        let script = ipc_resolve_script(&error, None);
        assert!(
            script.starts_with(r#"window.__bffiResolve({ "error": ""#)
                && script.ends_with(r#"" });"#),
            "the failure script must embed an escaped error object: {script}"
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
