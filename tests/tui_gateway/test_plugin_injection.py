"""Plugin wakes must reach only their original, profile-owned TUI session."""
from types import SimpleNamespace

import pytest
import yaml

from hermes_cli.plugins import PluginContext, PluginManifest, get_plugin_manager
from tui_gateway import server


class MemoryTransport:
    closed = False

    def write(self, frame):
        return True


@pytest.fixture
def host(tmp_path, monkeypatch):
    home = tmp_path / "profile"
    home.mkdir()
    (home / "config.yaml").write_text(yaml.safe_dump({
        "plugins": {"entries": {"wake": {"allow_gateway_injection": True}}}
    }))
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server, "_plugin_messages_stopped", False, raising=False)
    monkeypatch.setattr(server, "_start_notification_poller", lambda *args: None)
    monkeypatch.setattr(server, "_notify_session_boundary", lambda *args: None)
    receipts = []
    dispatch = server.dispatch

    def observe_dispatch(*args, **kwargs):
        result = dispatch(*args, **kwargs)
        receipts.append(result)
        return result

    monkeypatch.setattr(server, "dispatch", observe_dispatch)
    transport = MemoryTransport()
    record = {"session_key": "original", "profile_home": str(home), "transport": transport,
              "agent": SimpleNamespace(session_id="original"), "running": False, "history": []}
    server._sessions["runtime"] = record
    manager = get_plugin_manager()
    context = PluginContext(PluginManifest(name="wake", key="wake", source="user"), manager)
    yield context, manager, record, receipts
    server._clear_plugin_message_injectors()


@pytest.mark.parametrize("replacement_kind", ["new-record", "reset-in-place", "closed", "profile-switch"])
def test_admitted_wake_cannot_retarget_a_reused_runtime_id(host, monkeypatch, replacement_kind):
    context, _, record, receipts = host
    server._start_session_services("runtime", "original", record)
    replacement = dict(record, session_key="replacement", history=[]) if replacement_kind == "new-record" else record
    lookup = server._sess_nowait

    def replace_before_admission(*args):
        if replacement_kind == "new-record":
            server._sessions["runtime"] = replacement
        elif replacement_kind == "closed":
            record["_closing"] = True
        elif replacement_kind == "profile-switch":
            record["profile_home"] = "/foreign/profile"
        else:
            record["session_key"] = "replacement"
            record["agent"] = SimpleNamespace(session_id="replacement")
        return lookup(*args)

    monkeypatch.setattr(server, "_sess_nowait", replace_before_admission)
    assert context.inject_message("advance owned work", session_key="original") is False
    assert receipts[-1]["error"]["code"] == 4001
    assert replacement["history"] == []
    assert context.inject_message("stale wake", session_key="original") is False


@pytest.mark.parametrize("boundary", ["missing", "closed", "ambiguous", "foreign-profile"])
def test_unowned_or_ended_session_never_admits_a_wake(host, boundary):
    context, _, record, receipts = host
    server._start_session_services("runtime", "original", record)
    if boundary == "missing":
        server._sessions.clear()
    elif boundary == "closed":
        record["_closing"] = True
    elif boundary == "ambiguous":
        server._sessions["another-runtime"] = dict(record)
    else:
        record["profile_home"] = "/foreign/profile"
    assert context.inject_message("advance owned work", session_key="original") is False
    assert receipts == []


@pytest.mark.parametrize("new_owner_first", [True, False])
def test_tui_registration_and_shutdown_preserve_another_gateway_owner(host, new_owner_first):
    context, manager, record, _ = host
    if not new_owner_first:
        server._start_session_services("runtime", "original", record)
    manager.set_gateway_message_injector(object(), lambda **kwargs: True)
    server._start_session_services("runtime", "original", record)
    server._clear_plugin_message_injectors()
    assert context.inject_message("gateway work", session_key="gateway-only-session") is True
