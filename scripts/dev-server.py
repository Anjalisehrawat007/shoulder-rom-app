#!/usr/bin/env python3
"""Static file server for capture/ and doctor-portal/ that disables caching,
so edits to app.js / portal.js / index.html always take effect on refresh
without stale-cache confusion."""
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


os.chdir(ROOT)
http.server.test(HandlerClass=NoCacheHandler, port=PORT)
