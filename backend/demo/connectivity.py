"""Device connectivity switch ("airplane mode" for the demo). Everything that talks to the remote system calls
``require_online()`` first; the dispatcher console and the in-process mock system of record are *the remote world* and
stay reachable regardless of this switch."""
from __future__ import annotations

import threading
from datetime import datetime, timezone


class OfflineError(RuntimeError):
    """Raised when an operation needs the network and the device is offline."""


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Connectivity:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.online = True
        self.since = now_iso()

    def set_online(self, online: bool) -> None:
        with self._lock:
            if online != self.online:
                self.online, self.since = online, now_iso()

    def require_online(self) -> None:
        if not self.online:
            raise OfflineError("The device is offline. Reconnect to do this.")


connectivity = Connectivity()
