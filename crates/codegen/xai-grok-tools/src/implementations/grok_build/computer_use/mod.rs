//! `computer` tool — model-agnostic desktop computer use.
//!
//! A port of Codex's computer-use loop that works with any provider: the model sends a
//! batch of structured [`ComputerAction`]s (click, type, keypress, scroll, drag, wait,
//! screenshot) as ordinary JSON function arguments, the tool performs them on the local
//! desktop through a platform backend, and returns a fresh screenshot plus a summary so
//! the model can observe the result and decide the next step.
//!
//! Screenshots are downscaled so the longest side is at most
//! [`ComputerUseParams::max_screenshot_dimension`] pixels; the model works in that
//! screenshot coordinate space and the tool maps clicks back onto the physical screen.
//!
//! The tool is registered only when [`ComputerUseConfig::Enabled`] (the `computer_use`
//! feature flag) and every call goes through the native permission flow as
//! `AccessKind::Computer`.

pub mod action;
pub mod backend;
pub mod keys;
mod linux;
mod macos;
mod windows;

use std::sync::Arc;

use serde::{Deserialize, Serialize};

pub use action::{ComputerAction, MouseButton, Point};
pub use backend::{ComputerBackend, ComputerUseError, ScreenSize, detect_backend};

use crate::register_resource;
use crate::types::requirements::{Expr, ToolRequirement};
use crate::types::resources::Params;
use crate::types::tool::{ToolKind, ToolNamespace};
use crate::util::base64_images::ExtractedImage;

pub const COMPUTER_USE_TOOL_NAME: &str = "computer";

// ───────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────

/// Whether the `computer` tool is offered to the model.
#[derive(Debug, Clone, Default)]
pub enum ComputerUseConfig {
    #[default]
    Disabled,
    Enabled {
        params: ComputerUseParams,
    },
}

impl ComputerUseConfig {
    pub fn is_enabled(&self) -> bool {
        matches!(self, Self::Enabled { .. })
    }
}

/// Runtime parameters, stored as `Params<ComputerUseParams>` in `Resources`.
/// `None` means "use the built-in default".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComputerUseParams {
    /// X11 `DISPLAY` to drive on Linux (default: the process's own `DISPLAY`).
    pub display: Option<String>,
    /// Longest screenshot side in pixels; larger screens are downscaled. Default 1280.
    pub max_screenshot_dimension: Option<u32>,
    /// Maximum actions accepted in one call. Default 20.
    pub max_actions_per_call: Option<usize>,
    /// Pause after the last input action before the screenshot so the UI settles. Default 500.
    pub settle_ms: Option<u64>,
}

register_resource!("grok_build", "ComputerUse", ComputerUseParams);

impl ComputerUseParams {
    pub fn max_screenshot_dimension(&self) -> u32 {
        self.max_screenshot_dimension.unwrap_or(1280).max(200)
    }
    pub fn max_actions_per_call(&self) -> usize {
        self.max_actions_per_call.unwrap_or(20).max(1)
    }
    pub fn settle_ms(&self) -> u64 {
        self.settle_ms.unwrap_or(500).min(10_000)
    }
}

/// Injected backend override (tests and embedders). When absent the tool detects the
/// platform backend on every call.
#[derive(Clone)]
pub struct ComputerBackendHandle(pub Arc<dyn ComputerBackend>);

impl std::fmt::Debug for ComputerBackendHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ComputerBackendHandle({})", self.0.name())
    }
}

register_resource!("grok_build", "ComputerBackend", ComputerBackendHandle);

// ───────────────────────────────────────────────────────────────────────────
// Input / output
// ───────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ComputerUseInput {
    /// Actions to perform in order. Use `[{"type": "screenshot"}]` to only look. Every
    /// call ends with a fresh screenshot, so do not append one after other actions.
    #[schemars(
        description = "Actions to perform in order on the desktop. Coordinates are pixels in the most recent screenshot (origin top-left). A screenshot is always returned after the batch."
    )]
    pub actions: Vec<ComputerAction>,
}

/// Screen and screenshot geometry so the model knows the coordinate space.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
pub struct ScreenGeometry {
    pub screen_width: u32,
    pub screen_height: u32,
    pub screenshot_width: u32,
    pub screenshot_height: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ComputerUseOutput {
    /// Backend label (`"xdotool + scrot (X11)"`).
    pub backend: String,
    /// Human-readable descriptions of the actions that ran, in order.
    pub performed: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen: Option<ScreenGeometry>,
    /// The screenshot, drained by the shell into the multimodal follow-up.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(skip)]
    pub extracted_images: Vec<ExtractedImage>,
    /// Set when the call did not fully succeed; `performed` lists what ran before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl xai_tool_runtime::ToolOutput for ComputerUseOutput {}

impl ComputerUseOutput {
    fn failure(backend: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            backend: backend.into(),
            error: Some(error.into()),
            ..Self::default()
        }
    }

    pub fn is_error(&self) -> bool {
        self.error.is_some()
    }

    pub fn to_prompt_format(&self) -> String {
        let mut out = String::new();
        if self.performed.is_empty() {
            if self.error.is_none() {
                out.push_str("Captured the screen.\n");
            }
        } else {
            out.push_str(&format!("Performed {} action(s):\n", self.performed.len()));
            for (i, action) in self.performed.iter().enumerate() {
                out.push_str(&format!("  {}. {action}\n", i + 1));
            }
        }
        if let Some(error) = &self.error {
            out.push_str(&format!("Error: {error}\n"));
        }
        if let Some(geo) = &self.screen {
            if geo.screen_width == geo.screenshot_width
                && geo.screen_height == geo.screenshot_height
            {
                out.push_str(&format!(
                    "Screen: {}x{} px (screenshot is 1:1).\n",
                    geo.screen_width, geo.screen_height
                ));
            } else {
                out.push_str(&format!(
                    "Screen: {}x{} px, shown as a {}x{} screenshot. Give coordinates in screenshot pixels.\n",
                    geo.screen_width, geo.screen_height, geo.screenshot_width, geo.screenshot_height
                ));
            }
        }
        if !self.extracted_images.is_empty() {
            out.push_str(&format!(
                "{} The screenshot taken after these actions follows.",
                crate::util::base64_images::IMAGE_CONTENT_PLACEHOLDER
            ));
        }
        out.trim_end().to_owned()
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Tool
// ───────────────────────────────────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct ComputerUseTool;

impl crate::types::tool_metadata::ToolMetadata for ComputerUseTool {
    fn kind(&self) -> ToolKind {
        ToolKind::ComputerUse
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn description_template(&self) -> &str {
        r#"Control the user's desktop: look at the screen and drive it with the mouse and keyboard.

Every call performs the given actions in order and then returns a screenshot of the whole screen, so you can see what happened. Coordinates are pixels in the most recent screenshot (origin top-left); the tool maps them onto the physical screen for you.

Actions:
  - {"type": "screenshot"} — only look
  - {"type": "click", "x", "y", "button": "left|right|middle|back|forward"}
  - {"type": "double_click", "x", "y"}
  - {"type": "move", "x", "y"}
  - {"type": "drag", "path": [{"x","y"}, ...]} — press at the first point, release at the last
  - {"type": "scroll", "x", "y", "scroll_x", "scroll_y"} — wheel notches; positive scroll_y scrolls down
  - {"type": "keypress", "keys": ["ctrl", "l"]} — one key or a chord; also "ctrl+l"
  - {"type": "type", "text": "..."} — type literal text into the focused control
  - {"type": "wait", "ms": 1000} — let the UI settle

Usage notes:
  - Start with a screenshot to see the current state before acting.
  - Keep batches short (a click, then a type, then look) so you can verify each step.
  - Prefer keyboard shortcuts over hunting for small targets; use `wait` after actions that open windows or load pages.
  - Never enter credentials or make purchases unless the user explicitly asked you to in this conversation."#
    }

    fn requires_expr(&self) -> Expr<ToolRequirement> {
        Expr::True
    }
}

impl xai_tool_runtime::Tool for ComputerUseTool {
    type Args = ComputerUseInput;
    type Output = ComputerUseOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new(COMPUTER_USE_TOOL_NAME).expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &::xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            COMPUTER_USE_TOOL_NAME,
            crate::types::tool_metadata::ToolMetadata::sanitized_description_template(self),
        )
    }

    fn capabilities(&self) -> xai_tool_protocol::ToolCapabilities {
        xai_tool_protocol::ToolCapabilities {
            is_read_only: false,
            tool_scope: Some(xai_tool_protocol::ToolScope::Write),
            ..Default::default()
        }
    }

    #[tracing::instrument(name = "tool.computer", skip_all, fields(actions = input.actions.len()))]
    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: ComputerUseInput,
    ) -> Result<ComputerUseOutput, xai_tool_runtime::ToolError> {
        use crate::types::tool_metadata::shared_resources;
        let resources = shared_resources(&ctx)?;
        let (params, injected) = {
            let res = resources.lock().await;
            (
                res.get::<Params<ComputerUseParams>>()
                    .map(|p| p.0.clone())
                    .unwrap_or_default(),
                res.get::<ComputerBackendHandle>().cloned(),
            )
        };
        Ok(execute(&params, injected, input.actions).await)
    }
}

/// Run one call end to end. Failures are reported in the output (not as a `ToolError`) so
/// the model gets an actionable message and, when possible, a screenshot of the state.
pub async fn execute(
    params: &ComputerUseParams,
    injected: Option<ComputerBackendHandle>,
    actions: Vec<ComputerAction>,
) -> ComputerUseOutput {
    if actions.is_empty() {
        return ComputerUseOutput::failure(
            "",
            "no actions given; use [{\"type\": \"screenshot\"}] to look at the screen",
        );
    }
    if actions.len() > params.max_actions_per_call() {
        return ComputerUseOutput::failure(
            "",
            format!(
                "too many actions ({}); send at most {} per call and look at the screenshot between batches",
                actions.len(),
                params.max_actions_per_call()
            ),
        );
    }

    let backend: Arc<dyn ComputerBackend> = match injected {
        Some(handle) => handle.0,
        None => match detect_backend(params.display.as_deref()) {
            Ok(b) => Arc::from(b),
            Err(e) => return ComputerUseOutput::failure("", e.to_string()),
        },
    };
    let backend_name = backend.name();

    let screen = match backend.screen_size().await {
        Ok(s) if s.width > 0 && s.height > 0 => s,
        Ok(s) => {
            return ComputerUseOutput::failure(
                backend_name,
                format!(
                    "backend reported an empty screen ({}x{})",
                    s.width, s.height
                ),
            );
        }
        Err(e) => return ComputerUseOutput::failure(backend_name, e.to_string()),
    };
    let scale = screenshot_scale(screen, params.max_screenshot_dimension());
    let geometry = ScreenGeometry {
        screen_width: screen.width,
        screen_height: screen.height,
        screenshot_width: scaled_dim(screen.width, scale),
        screenshot_height: scaled_dim(screen.height, scale),
    };

    let mut output = ComputerUseOutput {
        backend: backend_name,
        screen: Some(geometry.clone()),
        ..ComputerUseOutput::default()
    };

    // Validate the whole batch before touching the desktop.
    for (i, action) in actions.iter().enumerate() {
        if let Err(reason) = action.validate(geometry.screenshot_width, geometry.screenshot_height)
        {
            output.error = Some(format!(
                "action {} ({}): {reason}",
                i + 1,
                action.describe()
            ));
            return output;
        }
    }

    let scaled: Vec<ComputerAction> = actions.iter().map(|a| a.scaled(scale)).collect();
    let touched_desktop;
    match backend.perform_batch(&scaled).await {
        Ok(()) => {
            output.performed = describe_performed(&actions);
            touched_desktop = actions.iter().any(|a| !a.is_observation());
        }
        Err(failure) => {
            output.performed = describe_performed(&actions[..failure.index]);
            touched_desktop = actions[..=failure.index.min(actions.len() - 1)]
                .iter()
                .any(|a| !a.is_observation());
            output.error = Some(format!(
                "action {} ({}) failed: {}",
                failure.index + 1,
                actions[failure.index.min(actions.len() - 1)].describe(),
                failure.error
            ));
        }
    }

    if touched_desktop {
        tokio::time::sleep(std::time::Duration::from_millis(params.settle_ms())).await;
    }

    match backend.capture_png().await {
        Ok(png) => match encode_screenshot(png, &geometry).await {
            Ok(image) => output.extracted_images.push(image),
            Err(e) => append_error(
                &mut output,
                format!("screenshot could not be processed: {e}"),
            ),
        },
        Err(e) => append_error(&mut output, format!("screenshot failed: {e}")),
    }
    output
}

/// Descriptions of the actions that ran; the implicit end-of-batch screenshot is not listed.
fn describe_performed(actions: &[ComputerAction]) -> Vec<String> {
    actions
        .iter()
        .filter(|a| !matches!(a, ComputerAction::Screenshot))
        .map(ComputerAction::describe)
        .collect()
}

fn append_error(output: &mut ComputerUseOutput, msg: String) {
    output.error = Some(match output.error.take() {
        Some(existing) => format!("{existing}; {msg}"),
        None => msg,
    });
}

/// Ratio screenshot/screen, `1.0` when the screen already fits.
fn screenshot_scale(screen: ScreenSize, max_dim: u32) -> f64 {
    let longest = screen.width.max(screen.height);
    if longest <= max_dim {
        1.0
    } else {
        f64::from(max_dim) / f64::from(longest)
    }
}

fn scaled_dim(v: u32, scale: f64) -> u32 {
    ((f64::from(v) * scale).round() as u32).max(1)
}

/// Downscale the PNG to the screenshot geometry (when needed) and base64-encode it.
async fn encode_screenshot(
    png: Vec<u8>,
    geometry: &ScreenGeometry,
) -> Result<ExtractedImage, String> {
    use base64::Engine as _;
    let target = (geometry.screenshot_width, geometry.screenshot_height);
    let needs_resize = target != (geometry.screen_width, geometry.screen_height);
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let img = image::load_from_memory(&png).map_err(|e| e.to_string())?;
        // Retina/HiDPI captures come back larger than the logical screen; resize whenever
        // the captured pixels differ from the target, not only when the scale is < 1.
        if !needs_resize && (img.width(), img.height()) == target {
            return Ok(png);
        }
        let resized = img.resize_exact(target.0, target.1, image::imageops::FilterType::Triangle);
        let mut out = std::io::Cursor::new(Vec::new());
        resized
            .write_to(&mut out, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        Ok(out.into_inner())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(ExtractedImage {
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime_type: "image/png".to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::backend::fake::FakeBackend;
    use super::*;
    use crate::types::tool_metadata::test_ctx_with_call_id;

    /// Registry-level round trip: the tool is registered from a `GrokBuild:computer` config
    /// entry, its `[toolset.computer_use]` params land in `Params<ComputerUseParams>`, the
    /// injected backend is picked up from `Resources`, and the typed output carries the
    /// screenshot for the shell's image drain.
    #[tokio::test]
    async fn registry_round_trip_uses_params_and_injected_backend() {
        use crate::registry::types::{
            SessionContext, ToolConfig, ToolRegistryBuilder, ToolServerConfig,
        };
        use std::collections::HashMap;

        let tmp = tempfile::TempDir::new().unwrap();
        let config = ToolServerConfig {
            tools: vec![ToolConfig {
                id: "GrokBuild:computer".to_owned(),
                params: Some(
                    serde_json::json!({ "max_actions_per_call": 2, "settle_ms": 0 })
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
                name_override: None,
                params_name_overrides: None,
                description_override: None,
                behavior_version: None,
                kind: None,
            }],
            behavior_preset: None,
        };
        let ctx = SessionContext {
            backend: Arc::new(crate::computer::local::LocalTerminalBackend::new()),
            fs: Arc::new(crate::computer::local::LocalFs),
            cwd: tmp.path().to_path_buf(),
            session_folder: tmp.path().join("session"),
            session_env: Arc::new(HashMap::new()),
            notification_handle: crate::notification::ToolNotificationHandle::noop(),
            owner_session_id: None,
            subagent: None,
            parent_scheduler_handle: None,
            skills: vec![],
            state_path: tmp.path().join("state.json"),
            memory_backend: None,
            web_search_config: Default::default(),
            web_fetch_config: Default::default(),
            lsp: None,
            image_gen_config: Default::default(),
            video_gen_config: Default::default(),
            app_builder_deployer_config: Default::default(),
            api_key_provider: None,
            auth_provider: None,
            attribution_callback: None,
            system_reminder_tag: crate::reminders::DEFAULT_REMINDER_TAG,
        };
        let toolset = Arc::new(
            ToolRegistryBuilder::new()
                .finalize(config, ctx)
                .expect("computer tool finalizes from config"),
        );
        assert!(
            toolset
                .tool_definitions()
                .iter()
                .any(|d| d.function.name == COMPUTER_USE_TOOL_NAME),
            "`computer` must be advertised to the model when registered"
        );

        let backend = fake(640, 480);
        let performed = backend.performed.clone();
        toolset
            .resources
            .lock()
            .await
            .insert(ComputerBackendHandle(Arc::new(backend)));

        // Two actions: within the configured cap, performed on the injected backend.
        let ok = toolset
            .call(
                COMPUTER_USE_TOOL_NAME,
                serde_json::json!({ "actions": [
                    { "type": "click", "x": 10, "y": 20 },
                    { "type": "type", "text": "hi" }
                ] }),
                "cu-registry-ok",
                None,
            )
            .await
            .expect("call succeeds");
        let crate::types::output::ToolOutput::ComputerUse(out) = &ok.output else {
            panic!("expected ComputerUse output, got {:?}", ok.output);
        };
        assert_eq!(out.backend, "fake");
        assert_eq!(out.performed.len(), 2);
        assert!(out.error.is_none(), "{:?}", out.error);
        assert_eq!(
            out.extracted_images.len(),
            1,
            "screenshot attached for the image drain"
        );
        assert_eq!(performed.lock().unwrap().len(), 2);
        assert!(
            ok.prompt_text.contains("Performed 2 action(s)"),
            "{}",
            ok.prompt_text
        );

        // Three actions: exceeds the `max_actions_per_call = 2` from the config params.
        let capped = toolset
            .call(
                COMPUTER_USE_TOOL_NAME,
                serde_json::json!({ "actions": [
                    { "type": "wait", "ms": 1 },
                    { "type": "wait", "ms": 1 },
                    { "type": "wait", "ms": 1 }
                ] }),
                "cu-registry-capped",
                None,
            )
            .await
            .expect("call returns an in-band error, not a ToolError");
        let crate::types::output::ToolOutput::ComputerUse(out) = &capped.output else {
            panic!("expected ComputerUse output");
        };
        assert!(
            out.error
                .as_deref()
                .is_some_and(|e| e.contains("at most 2 per call")),
            "config param must cap the batch: {:?}",
            out.error
        );
        assert_eq!(
            performed.lock().unwrap().len(),
            2,
            "capped batch never reaches the desktop"
        );
    }

    fn tiny_png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(w, h, image::Rgba([10, 20, 30, 255]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    fn fake(w: u32, h: u32) -> FakeBackend {
        FakeBackend {
            size: (w, h),
            png: tiny_png(w, h),
            ..FakeBackend::default()
        }
    }

    fn decode(image: &ExtractedImage) -> image::DynamicImage {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&image.data)
            .unwrap();
        image::load_from_memory(&bytes).unwrap()
    }

    #[test]
    fn tool_identity() {
        let tool = ComputerUseTool;
        assert_eq!(xai_tool_runtime::Tool::id(&tool).as_str(), "computer");
        assert_eq!(
            crate::types::tool_metadata::ToolMetadata::kind(&tool),
            ToolKind::ComputerUse
        );
        assert!(!crate::types::tool_metadata::ToolMetadata::is_read_only(
            &tool
        ));
    }

    #[tokio::test]
    async fn screenshot_only_returns_image_and_geometry_without_input() {
        let backend = fake(800, 600);
        let out = execute(
            &ComputerUseParams::default(),
            Some(ComputerBackendHandle(Arc::new(backend.clone()))),
            vec![ComputerAction::Screenshot],
        )
        .await;
        assert!(out.error.is_none(), "{out:?}");
        assert_eq!(
            out.screen,
            Some(ScreenGeometry {
                screen_width: 800,
                screen_height: 600,
                screenshot_width: 800,
                screenshot_height: 600,
            })
        );
        assert_eq!(out.extracted_images.len(), 1);
        assert_eq!(out.extracted_images[0].mime_type, "image/png");
        assert!(backend.performed.lock().unwrap().is_empty());
        assert_eq!(*backend.captures.lock().unwrap(), 1);
        let text = out.to_prompt_format();
        assert!(text.contains("Captured the screen"), "{text}");
        assert!(
            text.contains(crate::util::base64_images::IMAGE_CONTENT_PLACEHOLDER),
            "{text}"
        );
    }

    #[tokio::test]
    async fn large_screen_is_downscaled_and_clicks_are_mapped_back() {
        let backend = fake(2560, 1440);
        let params = ComputerUseParams {
            max_screenshot_dimension: Some(1280),
            settle_ms: Some(0),
            ..Default::default()
        };
        let out = execute(
            &params,
            Some(ComputerBackendHandle(Arc::new(backend.clone()))),
            vec![ComputerAction::Click {
                x: 640,
                y: 360,
                button: MouseButton::Left,
            }],
        )
        .await;
        assert!(out.error.is_none(), "{out:?}");
        let geo = out.screen.clone().unwrap();
        assert_eq!((geo.screenshot_width, geo.screenshot_height), (1280, 720));
        let performed = backend.performed.lock().unwrap();
        assert_eq!(
            performed[0],
            ComputerAction::Click {
                x: 1280,
                y: 720,
                button: MouseButton::Left
            }
        );
        let img = decode(&out.extracted_images[0]);
        assert_eq!((img.width(), img.height()), (1280, 720));
        assert!(
            out.to_prompt_format()
                .contains("shown as a 1280x720 screenshot")
        );
    }

    #[tokio::test]
    async fn out_of_bounds_action_is_rejected_before_anything_runs() {
        let backend = fake(800, 600);
        let out = execute(
            &ComputerUseParams::default(),
            Some(ComputerBackendHandle(Arc::new(backend.clone()))),
            vec![
                ComputerAction::Type {
                    text: "hello".into(),
                },
                ComputerAction::Click {
                    x: 900,
                    y: 10,
                    button: MouseButton::Left,
                },
            ],
        )
        .await;
        let err = out.error.as_deref().unwrap();
        assert!(err.contains("action 2"), "{err}");
        assert!(err.contains("outside the 800x600 screenshot"), "{err}");
        assert!(backend.performed.lock().unwrap().is_empty());
        assert!(out.performed.is_empty());
    }

    #[tokio::test]
    async fn partial_failure_reports_completed_prefix_and_still_screenshots() {
        let mut backend = fake(800, 600);
        backend.fail_on = Some(1);
        let params = ComputerUseParams {
            settle_ms: Some(0),
            ..Default::default()
        };
        let out = execute(
            &params,
            Some(ComputerBackendHandle(Arc::new(backend.clone()))),
            vec![
                ComputerAction::Move { x: 1, y: 1 },
                ComputerAction::Type {
                    text: "boom".into(),
                },
                ComputerAction::Move { x: 2, y: 2 },
            ],
        )
        .await;
        assert_eq!(out.performed, vec!["move pointer to (1, 1)"]);
        let err = out.error.as_deref().unwrap();
        assert!(err.starts_with("action 2 (type \"boom\") failed"), "{err}");
        assert!(err.contains("simulated failure"), "{err}");
        assert_eq!(out.extracted_images.len(), 1, "screenshot still captured");
        assert!(out.is_error());
    }

    #[tokio::test]
    async fn empty_and_oversized_batches_are_rejected() {
        let out = execute(&ComputerUseParams::default(), None, vec![]).await;
        assert!(out.error.as_deref().unwrap().contains("no actions"));
        let params = ComputerUseParams {
            max_actions_per_call: Some(2),
            ..Default::default()
        };
        let out = execute(
            &params,
            Some(ComputerBackendHandle(Arc::new(fake(10, 10)))),
            vec![ComputerAction::Screenshot; 3],
        )
        .await;
        assert!(out.error.as_deref().unwrap().contains("too many actions"));
    }

    #[tokio::test]
    async fn run_reads_params_and_backend_from_resources() {
        let mut resources = crate::types::resources::Resources::new();
        resources.insert(Params(ComputerUseParams {
            settle_ms: Some(0),
            ..Default::default()
        }));
        let backend = fake(640, 480);
        resources.insert(ComputerBackendHandle(Arc::new(backend.clone())));
        let out = xai_tool_runtime::Tool::run(
            &ComputerUseTool,
            test_ctx_with_call_id(resources.into_shared(), "call-1"),
            ComputerUseInput {
                actions: vec![ComputerAction::Keypress {
                    keys: vec!["ctrl".into(), "l".into()],
                }],
            },
        )
        .await
        .unwrap();
        assert!(out.error.is_none(), "{out:?}");
        assert_eq!(out.performed, vec!["press ctrl+l"]);
        assert_eq!(backend.performed.lock().unwrap().len(), 1);
    }

    #[test]
    fn input_schema_accepts_openai_style_actions() {
        let input: ComputerUseInput = serde_json::from_value(serde_json::json!({
            "actions": [
                {"type": "click", "x": 10, "y": 20},
                {"type": "type", "text": "hi"},
                {"type": "keypress", "keys": ["enter"]},
            ]
        }))
        .unwrap();
        assert_eq!(input.actions.len(), 3);
    }
}
