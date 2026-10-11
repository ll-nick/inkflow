"""The WebSocket on the HTTP port: an upgrade request the HTTP handler has
read is handed, connection and all, to websockets.

The HTTP server is asyncio streams (files stream in chunks, with byte
ranges), so websockets' own listener cannot serve it, and its
``process_request`` hook would hold every response in memory. Instead the
HTTP handler reads the request head, checks it (host, origin, who), and when
it asks for ``/_inkflow/ws`` gives the socket's transport a websockets
``ServerConnection`` as its protocol and feeds it the head it read: from
there websockets answers the handshake and runs the connection as if it had
accepted it itself (pings, close handshake, flow control, TLS underneath).
One port then carries the pages, their pictures and the live connection,
which is what an SSH tunnel or a share link needs.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from typing import cast

from typing_extensions import override
from websockets.asyncio.server import Server, ServerConnection
from websockets.exceptions import ConnectionClosed
from websockets.extensions.permessage_deflate import enable_server_permessage_deflate
from websockets.frames import CloseCode
from websockets.protocol import State
from websockets.server import ServerProtocol

Handler = Callable[[ServerConnection], Awaitable[None]]


async def _unused() -> asyncio.Server:
    raise RuntimeError("the bridge has no listener of its own")


class Bridge(Server):
    """A websockets server without a listener: connections are adopted."""

    def __init__(
        self,
        handler: Handler,
        *,
        max_size: int | None = 2**20,
        forget: Callable[[ServerConnection], object] | None = None,
    ) -> None:
        self._inkflow_handler: Handler = handler
        self._forget: Callable[[ServerConnection], object] | None = forget
        """Called when a connection is gone, whether or not its handshake
        succeeded (the server drops it from the people connected)."""
        self._max_size: int | None = max_size
        self._open: bool = True
        self._writers: dict[ServerConnection, asyncio.StreamWriter] = {}
        super().__init__(_unused, self._run)

    @override
    def is_serving(self) -> bool:
        return self._open

    def adopt(self, writer: asyncio.StreamWriter, head: bytes) -> ServerConnection:
        """Take over the connection behind ``writer``, whose request head
        (an upgrade request) has been read already."""
        protocol = ServerProtocol(
            extensions=enable_server_permessage_deflate(None),
            max_size=self._max_size,
        )
        connection = ServerConnection(protocol, self)
        transport = cast("asyncio.Transport", writer.transport)
        # The stream writer would close the transport when collected.
        self._writers[connection] = writer
        transport.set_protocol(connection)
        connection.connection_made(transport)
        connection.data_received(head)
        return connection

    async def _run(self, connection: ServerConnection) -> None:
        """websockets' own connection lifecycle (``serve``'s handler)."""
        try:
            async with asyncio.timeout(10):
                await connection.handshake()
            if connection.protocol.state is not State.OPEN:
                connection.transport.abort()
                return
            self.all_connections.add(connection)
            connection.start_keepalive()
            try:
                await self._inkflow_handler(connection)
            except ConnectionClosed:
                pass  # the page went away mid-message: nothing to report
            except Exception:
                connection.logger.error("connection handler failed", exc_info=True)
                await connection.close(CloseCode.INTERNAL_ERROR)
            else:
                await connection.close()
            finally:
                self.all_connections.discard(connection)
        except Exception:
            connection.transport.abort()
        finally:
            _ = self._writers.pop(connection, None)
            if self._forget is not None:
                _ = self._forget(connection)
            self.handler_tasks.discard(
                cast("asyncio.Task[None]", asyncio.current_task())
            )

    async def shutdown(self) -> None:
        """Close every adopted connection (going away) and wait for them."""
        self._open = False
        tasks = [
            asyncio.create_task(c.close(CloseCode.GOING_AWAY))
            for c in list(self.all_connections)
        ]
        if tasks:
            _ = await asyncio.wait(tasks, timeout=3)
        if self.handler_tasks:
            _ = await asyncio.wait(list(self.handler_tasks), timeout=3)
        for task in list(self.handler_tasks):
            _ = task.cancel()
            with contextlib.suppress(BaseException):
                await task
