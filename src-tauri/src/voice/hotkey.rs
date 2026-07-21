use crate::voice::core::{VoiceEvent, VoiceEventKind};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HotkeyAction {
    TogglePressed,
    PushToTalkPressed,
    PushToTalkReleased,
    CancelPressed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HotkeyStateMachine {
    shortcut: String,
    recording: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceHotkeyEvent {
    pub shortcut: String,
    pub event: VoiceEvent,
    pub kind: VoiceEventKind,
    pub status_hint: String,
}

impl HotkeyStateMachine {
    pub fn new_toggle(shortcut: impl Into<String>) -> Self {
        Self {
            shortcut: shortcut.into(),
            recording: false,
        }
    }

    pub fn shortcut(&self) -> &str {
        &self.shortcut
    }

    pub fn handle_action(&mut self, action: HotkeyAction) -> Option<VoiceEvent> {
        match action {
            HotkeyAction::TogglePressed => {
                self.recording = !self.recording;
                if self.recording {
                    Some(VoiceEvent::TriggerStart)
                } else {
                    Some(VoiceEvent::TriggerStop)
                }
            }
            HotkeyAction::PushToTalkPressed if !self.recording => {
                self.recording = true;
                Some(VoiceEvent::TriggerStart)
            }
            HotkeyAction::PushToTalkReleased if self.recording => {
                self.recording = false;
                Some(VoiceEvent::TriggerStop)
            }
            HotkeyAction::CancelPressed => {
                self.recording = false;
                Some(VoiceEvent::TriggerCancel)
            }
            _ => None,
        }
    }
}

pub fn handle_voice_toggle_hotkey(hotkeys: &mut HotkeyStateMachine) -> Option<VoiceHotkeyEvent> {
    let shortcut = hotkeys.shortcut().to_string();
    hotkeys
        .handle_action(HotkeyAction::TogglePressed)
        .map(|event| {
            let kind = event.kind();
            let status_hint = match kind {
                VoiceEventKind::TriggerStart => "recording",
                VoiceEventKind::TriggerStop => "transcribing",
                VoiceEventKind::TriggerCancel => "cancelled",
                _ => "unknown",
            }
            .to_string();

            VoiceHotkeyEvent {
                shortcut,
                event,
                kind,
                status_hint,
            }
        })
}
