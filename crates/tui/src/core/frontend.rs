//! Abstract UI layer.
//!
//! This module is the seam between an *agent session* (the engine, driven
//! through [`EngineHandle`] with [`Op`] in and [`Event`] out) and any concrete
//! *user interface* that observes and drives it. The goal is that the TUI, a
//! web frontend, an ACP adapter, or a test harness are all just
//! implementations of one small contract rather than bespoke consumers wired
//! directly into the engine's channels.
//!
//! Three pieces make that possible:
//!
//! - [`SessionController`] is the **input** surface. It wraps an
//!   [`EngineHandle`] and exposes the operations a UI needs (send a message,
//!   approve/deny a tool call, steer, cancel, shut down) without leaking the
//!   raw mpsc channels or the full [`Op`] enum.
//! - [`EventHub`] is the **output** fan-out. The engine emits events over a
//!   *single-consumer* `mpsc` channel, which means only one UI could ever read
//!   them. The hub drains that channel once (via [`spawn_event_pump`]) and
//!   re-broadcasts each event as an `Arc<Event>` to any number of subscribers.
//!   This is what lets a TUI and a web client watch the *same* live session.
//! - [`Frontend`] is the contract a concrete UI implements. [`run_frontend`]
//!   drives a `Frontend` from a hub subscription, turning the inlined
//!   `match event { .. }` loops that exist today into a reusable adapter.
//!
//! Adoption is incremental: existing consumers keep reading the engine
//! directly until they are migrated to subscribe to an [`EventHub`] instead.

// Staged abstraction: the TUI and web consumers are migrated onto this layer
// incrementally, so some of the public surface has no in-tree caller yet. The
// repo's established convention is to annotate such staged APIs rather than let
// CI's `-D warnings` flag them before their call sites land.
#![allow(dead_code)]

use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use tokio::sync::{broadcast, mpsc};

use crate::core::engine::EngineHandle;
use crate::core::events::Event;
use crate::core::ops::Op;
use crate::sandbox::SandboxPolicy;

/// Default capacity of the broadcast channel backing an [`EventHub`].
///
/// Generously sized: streaming turns can emit many token deltas in a short
/// window, and a slow subscriber that lags past this bound is told it lagged
/// (via [`broadcast::error::RecvError::Lagged`]) rather than silently dropping
/// the producer. UIs that must never miss deltas should drain promptly.
pub const EVENT_HUB_CAPACITY: usize = 4096;

/// Abstract **input** surface for an agent session.
///
/// Wraps an [`EngineHandle`] so a UI drives the session through a small, typed
/// API instead of constructing [`Op`] values and touching channels directly.
/// Cloneable and cheap to pass around; every clone targets the same engine.
#[derive(Clone)]
pub struct SessionController {
    handle: EngineHandle,
}

impl SessionController {
    /// Wrap an [`EngineHandle`] as a controller.
    #[must_use]
    pub fn new(handle: EngineHandle) -> Self {
        Self { handle }
    }

    /// Borrow the underlying handle, for operations not yet surfaced here.
    #[must_use]
    pub fn handle(&self) -> &EngineHandle {
        &self.handle
    }

    /// Submit an arbitrary operation to the engine.
    ///
    /// Convenience methods below cover the common cases; this is the escape
    /// hatch for ops (such as [`Op::SendMessage`]) whose construction is
    /// UI-specific.
    pub async fn submit(&self, op: Op) -> Result<()> {
        self.handle.send(op).await
    }

    /// Approve a pending tool call by id.
    pub async fn approve_tool(&self, id: impl Into<String>) -> Result<()> {
        self.handle.approve_tool_call(id).await
    }

    /// Deny a pending tool call by id.
    pub async fn deny_tool(&self, id: impl Into<String>) -> Result<()> {
        self.handle.deny_tool_call(id).await
    }

    /// Retry a denied tool call under an elevated sandbox policy.
    pub async fn retry_tool_with_policy(
        &self,
        id: impl Into<String>,
        policy: SandboxPolicy,
    ) -> Result<()> {
        self.handle.retry_tool_with_policy(id, policy).await
    }

    /// Inject additional user input into the in-flight turn.
    pub async fn steer(&self, content: impl Into<String>) -> Result<()> {
        self.handle.steer(content).await
    }

    /// Cancel the current request (user-initiated).
    pub fn cancel(&self) {
        self.handle.cancel();
    }

    /// Ask the engine to shut down its run loop.
    pub async fn shutdown(&self) -> Result<()> {
        self.handle.send(Op::Shutdown).await
    }
}

/// **Output** fan-out for an agent session.
///
/// Wraps a [`broadcast`] sender of `Arc<Event>`. Construct one, hand the
/// matching [`EngineHandle`] to [`spawn_event_pump`], then call
/// [`EventHub::subscribe`] for each UI that should observe the session.
#[derive(Clone)]
pub struct EventHub {
    tx: broadcast::Sender<Arc<Event>>,
}

impl EventHub {
    /// Create a hub with [`EVENT_HUB_CAPACITY`].
    #[must_use]
    pub fn new() -> Self {
        Self::with_capacity(EVENT_HUB_CAPACITY)
    }

    /// Create a hub with an explicit broadcast capacity.
    #[must_use]
    pub fn with_capacity(capacity: usize) -> Self {
        let (tx, _rx) = broadcast::channel(capacity.max(1));
        Self { tx }
    }

    /// Subscribe a new consumer. Each subscriber receives every event
    /// published after it subscribed.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Event>> {
        self.tx.subscribe()
    }

    /// Number of currently active subscribers.
    #[must_use]
    pub fn subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }

    /// Publish an event to all subscribers.
    ///
    /// Returns the number of subscribers the event reached. Zero is not an
    /// error: a session with no attached UI still runs, and history is
    /// persisted elsewhere.
    pub fn publish(&self, event: Event) -> usize {
        self.tx.send(Arc::new(event)).unwrap_or(0)
    }

    /// Clone the underlying broadcast sender, e.g. for a custom pump.
    #[must_use]
    pub fn sender(&self) -> broadcast::Sender<Arc<Event>> {
        self.tx.clone()
    }
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new()
    }
}

/// Drain an engine's single-consumer event channel into an [`EventHub`].
///
/// The engine emits [`Event`]s over an `mpsc` receiver that only one task may
/// own. This pump is that one task: it `recv`s each event and re-broadcasts it
/// through the hub so any number of [`Frontend`]s can observe it. The pump ends
/// when the engine closes its sender (no more events).
///
/// Returns the spawned task handle so callers can await or abort it.
#[track_caller]
pub fn spawn_event_pump(handle: EngineHandle, hub: EventHub) -> tokio::task::JoinHandle<()> {
    let location = std::panic::Location::caller();
    crate::utils::spawn_supervised("ui-event-pump", location, async move {
        loop {
            let event = {
                let mut rx = handle.rx_event.write().await;
                rx.recv().await
            };
            match event {
                Some(event) => {
                    // A send error only means there are no subscribers right
                    // now. Keep draining so the engine never blocks on a full
                    // channel and late subscribers see subsequent events.
                    let _ = hub.publish(event);
                }
                None => break,
            }
        }
    })
}

/// Contract implemented by a concrete UI to observe an agent session.
///
/// Implementations are driven by [`run_frontend`]. Keep [`Frontend::on_event`]
/// non-blocking: it runs inline in the consumer loop, so heavy work should be
/// offloaded to another task.
#[async_trait]
pub trait Frontend: Send {
    /// Called once before the event loop starts, with the input surface for
    /// the session this frontend is attached to.
    async fn on_attached(&mut self, _controller: SessionController) {}

    /// Handle a single event emitted by the session.
    async fn on_event(&mut self, event: Arc<Event>);

    /// Called when the event stream ends (engine closed or hub dropped).
    async fn on_detached(&mut self) {}
}

/// Drive a [`Frontend`] from an [`EventHub`] subscription until the stream ends.
///
/// A lagging subscriber (one that fell behind the broadcast capacity) skips the
/// dropped events and keeps going rather than tearing down the UI.
pub async fn run_frontend<F: Frontend>(
    mut events: broadcast::Receiver<Arc<Event>>,
    frontend: &mut F,
) {
    loop {
        match events.recv().await {
            Ok(event) => frontend.on_event(event).await,
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                tracing::warn!(
                    target: "frontend",
                    "frontend lagged behind event hub; skipped {skipped} events"
                );
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
    frontend.on_detached().await;
}

/// A [`Frontend`] that forwards every event into an `mpsc` channel.
///
/// This is the adapter an existing event loop (such as the TUI's) uses to
/// migrate onto the abstract layer without rewriting its consumer: subscribe to
/// the [`EventHub`], wrap the receiving half of an `mpsc` channel in a
/// `ForwardFrontend`, and let the loop keep `try_recv`/`recv`-ing as before.
pub struct ForwardFrontend {
    tx: mpsc::UnboundedSender<Arc<Event>>,
}

impl ForwardFrontend {
    /// Create a forwarder plus the receiving half the consumer loop reads.
    #[must_use]
    pub fn channel() -> (Self, mpsc::UnboundedReceiver<Arc<Event>>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { tx }, rx)
    }

    /// Wrap an existing sender.
    #[must_use]
    pub fn new(tx: mpsc::UnboundedSender<Arc<Event>>) -> Self {
        Self { tx }
    }
}

#[async_trait]
impl Frontend for ForwardFrontend {
    async fn on_event(&mut self, event: Arc<Event>) {
        let _ = self.tx.send(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::engine::{MockApprovalEvent, mock_engine_handle};
    use std::time::Duration;
    use tokio::time::timeout;

    fn status(msg: &str) -> Event {
        Event::status(msg)
    }

    /// A recording frontend for assertions.
    #[derive(Default)]
    struct Recorder {
        statuses: Vec<String>,
        detached: bool,
    }

    #[async_trait]
    impl Frontend for Recorder {
        async fn on_event(&mut self, event: Arc<Event>) {
            if let Event::Status { message } = event.as_ref() {
                self.statuses.push(message.clone());
            }
        }
        async fn on_detached(&mut self) {
            self.detached = true;
        }
    }

    #[tokio::test]
    async fn pump_forwards_engine_events_to_subscriber() {
        let mock = mock_engine_handle();
        let hub = EventHub::new();
        let mut sub = hub.subscribe();
        let _pump = spawn_event_pump(mock.handle.clone(), hub.clone());

        mock.tx_event.send(status("hello")).await.unwrap();

        let received = timeout(Duration::from_secs(1), sub.recv())
            .await
            .expect("event within timeout")
            .expect("event present");
        match received.as_ref() {
            Event::Status { message } => assert_eq!(message, "hello"),
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn hub_fans_out_to_multiple_subscribers() {
        let mock = mock_engine_handle();
        let hub = EventHub::new();
        let mut a = hub.subscribe();
        let mut b = hub.subscribe();
        let _pump = spawn_event_pump(mock.handle.clone(), hub.clone());

        mock.tx_event.send(status("broadcast")).await.unwrap();

        for sub in [&mut a, &mut b] {
            let ev = timeout(Duration::from_secs(1), sub.recv())
                .await
                .expect("event within timeout")
                .expect("event present");
            assert!(matches!(ev.as_ref(), Event::Status { message } if message == "broadcast"));
        }
    }

    #[tokio::test]
    async fn run_frontend_collects_until_stream_closes() {
        let mock = mock_engine_handle();
        let hub = EventHub::new();
        let sub = hub.subscribe();
        let _pump = spawn_event_pump(mock.handle.clone(), hub.clone());
        // Drop the local hub so the pump's clone is the only remaining sender;
        // when the pump ends, the subscriber observes `Closed`.
        drop(hub);

        mock.tx_event.send(status("one")).await.unwrap();
        mock.tx_event.send(status("two")).await.unwrap();
        // Drop the engine's sender so the pump ends and the hub closes.
        drop(mock.tx_event);

        let mut recorder = Recorder::default();
        timeout(Duration::from_secs(2), run_frontend(sub, &mut recorder))
            .await
            .expect("run_frontend completes when stream closes");

        assert_eq!(
            recorder.statuses,
            vec!["one".to_string(), "two".to_string()]
        );
        assert!(
            recorder.detached,
            "on_detached should fire when stream ends"
        );
    }

    #[tokio::test]
    async fn forward_frontend_bridges_hub_to_mpsc() {
        let mock = mock_engine_handle();
        let hub = EventHub::new();
        let sub = hub.subscribe();
        let _pump = spawn_event_pump(mock.handle.clone(), hub.clone());

        let (forward, mut rx) = ForwardFrontend::channel();
        tokio::spawn(async move {
            let mut forward = forward;
            run_frontend(sub, &mut forward).await;
        });

        mock.tx_event.send(status("bridged")).await.unwrap();

        let ev = timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("event within timeout")
            .expect("event present");
        assert!(matches!(ev.as_ref(), Event::Status { message } if message == "bridged"));
    }

    #[tokio::test]
    async fn controller_routes_approval_to_engine() {
        let mut mock = mock_engine_handle();
        let controller = SessionController::new(mock.handle.clone());

        controller.approve_tool("tool-1").await.unwrap();
        let decision = timeout(Duration::from_secs(1), mock.recv_approval_event())
            .await
            .expect("decision within timeout")
            .expect("decision present");
        assert_eq!(
            decision,
            MockApprovalEvent::Approved {
                id: "tool-1".to_string()
            }
        );

        controller.deny_tool("tool-2").await.unwrap();
        let decision = timeout(Duration::from_secs(1), mock.recv_approval_event())
            .await
            .expect("decision within timeout")
            .expect("decision present");
        assert_eq!(
            decision,
            MockApprovalEvent::Denied {
                id: "tool-2".to_string()
            }
        );
    }

    #[tokio::test]
    async fn controller_steer_reaches_engine() {
        let mut mock = mock_engine_handle();
        let controller = SessionController::new(mock.handle.clone());

        controller.steer("more context").await.unwrap();
        let steer = timeout(Duration::from_secs(1), mock.rx_steer.recv())
            .await
            .expect("steer within timeout")
            .expect("steer present");
        assert_eq!(steer, "more context");
    }
}
