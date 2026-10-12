"""Collapsed paste delivery through classic-CLI queue and live busy input."""

from queue import Queue
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from prompt_toolkit.buffer import Buffer

from cli import HermesCLI


def test_queue_expands_collapsed_paste_reference(tmp_path):
    pasted = "first\nmiddle\nlast"
    paste_file = tmp_path / "paste.txt"
    paste_file.write_text(pasted, encoding="utf-8")
    placeholder = f"[Pasted text #1: 3 lines → {paste_file}]"
    cli_obj = HermesCLI.__new__(HermesCLI)
    cli_obj._agent_running = False
    cli_obj._pending_input = Queue()
    cli_obj._pending_resume_sessions = None

    with patch("cli._cprint"):
        assert cli_obj.process_command(f"/queue {placeholder}") is True

    assert cli_obj._pending_input.get_nowait() == pasted


@pytest.mark.parametrize("mode", ["steer", "interrupt"])
@pytest.mark.parametrize("accepted", [True, False])
def test_busy_paste_is_expanded_before_live_injection(tmp_path, mode, accepted):
    class CapturingAgent:
        _supports_active_turn_redirect = True

        def __init__(self):
            self.steered = []
            self.redirected = []

        def steer(self, text):
            self.steered.append(text)
            return accepted

        def redirect(self, text):
            self.redirected.append(text)
            return accepted

    pasted = "\n".join([
        "!printf PASTED_SHELL_DATA",
        *[
            "CLASSIC_BUSY_MIDDLE_SENTINEL" if index == 8 else f"Acceptance detail {index + 1}"
            for index in range(17)
        ],
        "{!printf PASTED_INTERPOLATION_DATA}",
    ])
    cli_obj = HermesCLI.__new__(HermesCLI)
    cli_obj.config = {"paste_collapse_threshold": 3, "paste_collapse_char_threshold": 2000}
    cli_obj.busy_input_mode = mode
    cli_obj._agent_running = True
    cli_obj._tui_multiline_shortcuts = False
    cli_obj._tui_last_text_change = 0.0
    cli_obj._tui_paste_counter = 0
    cli_obj._attached_images = []
    cli_obj._pending_input = Queue()
    cli_obj._interrupt_queue = Queue()
    cli_obj.agent = CapturingAgent()
    buffer = Buffer()
    app = SimpleNamespace(current_buffer=buffer, invalidate=MagicMock(), is_running=False)
    event = SimpleNamespace(app=app, current_buffer=buffer, data=pasted)

    with (
        patch("cli._hermes_home", tmp_path),
        patch("cli._cprint"),
        patch("agent.onboarding.is_seen", return_value=True),
        patch.object(cli_obj, "_tui_enter_overlay", return_value=False),
    ):
        # Use the real bracketed-paste collapse and Enter handlers, not an
        # invented reference or direct call to the agent's injection method.
        cli_obj._tui_handle_paste(event)
        display = buffer.text
        assert "[Pasted text #1: 19 lines" in display
        assert "CLASSIC_BUSY_MIDDLE_SENTINEL" not in display
        cli_obj._tui_handle_enter(event)

    delivered = cli_obj.agent.steered if mode == "steer" else cli_obj.agent.redirected
    assert delivered == [pasted]
    assert buffer.history.get_strings() == [pasted]
    queue = cli_obj._pending_input if mode == "steer" else cli_obj._interrupt_queue
    if accepted:
        assert queue.empty()
    else:
        # Preserve the pre-expansion syntax boundary on a refused delivery.
        # Ordinary dispatch expands this only after bang/slash routing.
        assert queue.get_nowait() == display


def test_explicit_steer_expands_collapsed_paste_before_live_injection(tmp_path):
    pasted = "\n".join(f"detail {index}" for index in range(19))
    paste_file = tmp_path / "paste.txt"
    paste_file.write_text(pasted, encoding="utf-8")
    placeholder = f"[Pasted text #1: 19 lines → {paste_file}]"
    cli_obj = HermesCLI.__new__(HermesCLI)
    cli_obj._agent_running = True
    cli_obj.agent = SimpleNamespace(steer=MagicMock(return_value=True))
    with patch("cli._cprint"):
        assert cli_obj.process_command(f"/steer {placeholder}") is True
    cli_obj.agent.steer.assert_called_once_with(pasted)
