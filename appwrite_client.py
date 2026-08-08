"""Appwrite client for SupplyDesk.

The equivalent of the `appwrite.js` lib module from Appwrite's setup guide,
written for this project: the backend is Python and owns the data, so the
client lives server-side rather than in the browser. Built on urllib so the
project keeps its no-dependencies promise.

    from appwrite_client import client, databases
    client.ping()                       # verify the connection
    databases.list_documents("products")

Reads and writes need a server API key (APPWRITE_KEY); ping and other guest
calls work with the project id alone.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

ENDPOINT = os.environ.get("APPWRITE_ENDPOINT", "https://fra.cloud.appwrite.io/v1").rstrip("/")
PROJECT_ID = os.environ.get("APPWRITE_PROJECT", "6a7758560009963f67b0")
PROJECT_NAME = os.environ.get("APPWRITE_PROJECT_NAME", "database spice")
API_KEY = os.environ.get("APPWRITE_KEY", "")
DATABASE_ID = os.environ.get("APPWRITE_DB", "supplydesk")

TIMEOUT = 15


class AppwriteError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Client:
    def __init__(self, endpoint=ENDPOINT, project=PROJECT_ID, key=API_KEY):
        self.endpoint = endpoint
        self.project = project
        self.key = key

    @property
    def configured(self):
        return bool(self.endpoint and self.project)

    def call(self, method, path, body=None, query=None, raw=False):
        url = self.endpoint + path
        if query:
            url += "?" + urllib.parse.urlencode(query, doseq=True)
        headers = {"Content-Type": "application/json", "X-Appwrite-Project": self.project}
        if self.key:
            headers["X-Appwrite-Key"] = self.key
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(url, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, data, timeout=TIMEOUT) as res:
                payload = res.read()
                return payload.decode(errors="replace") if raw else json.loads(payload or b"{}")
        except urllib.error.HTTPError as e:
            body = e.read()
            try:
                message = json.loads(body or b"{}").get("message", body[:200].decode())
            except ValueError:
                message = body[:200].decode(errors="replace")
            raise AppwriteError(e.code, message)
        except urllib.error.URLError as e:
            raise AppwriteError(0, f"cannot reach {self.endpoint}: {e.reason}")

    def ping(self):
        """Verify the connection. Returns the server's reply ("Pong!")."""
        return self.call("GET", "/ping", raw=True)

    def status(self):
        """Connection summary for the UI."""
        info = {"endpoint": self.endpoint, "project": self.project,
                "project_name": PROJECT_NAME, "database": DATABASE_ID,
                "has_key": bool(self.key)}
        try:
            info["reply"] = self.ping().strip()
            info["ok"] = True
        except AppwriteError as e:
            info["ok"] = False
            info["error"] = e.message
            return info

        if not self.key:
            info["schema"] = "waiting for an API key"
            return info
        try:
            collections = self.call(
                "GET", f"/databases/{DATABASE_ID}/collections", query={"limit": 100})
            info["schema"] = f"{collections.get('total', 0)} collections"
            info["collections"] = [c["$id"] for c in collections.get("collections", [])]
        except AppwriteError as e:
            info["schema"] = f"not created yet ({e.message})"
        return info


class Databases:
    """The document operations SupplyDesk needs."""

    def __init__(self, client, database_id=DATABASE_ID):
        self.client = client
        self.database_id = database_id

    def _path(self, collection, document_id=None):
        base = f"/databases/{self.database_id}/collections/{collection}/documents"
        return f"{base}/{document_id}" if document_id else base

    def list_documents(self, collection, queries=None, limit=100, offset=0):
        query = [f'limit({limit})', f'offset({offset})'] + list(queries or [])
        result = self.client.call("GET", self._path(collection), query={"queries[]": query})
        return result.get("documents", [])

    def get_document(self, collection, document_id):
        return self.client.call("GET", self._path(collection, document_id))

    def create_document(self, collection, data, document_id="unique()"):
        return self.client.call("POST", self._path(collection),
                                {"documentId": document_id, "data": data})

    def update_document(self, collection, document_id, data):
        return self.client.call("PATCH", self._path(collection, document_id), {"data": data})

    def delete_document(self, collection, document_id):
        return self.client.call("DELETE", self._path(collection, document_id))


client = Client()
databases = Databases(client)
