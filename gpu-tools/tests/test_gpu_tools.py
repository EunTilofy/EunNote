from __future__ import annotations

from datetime import datetime, timezone
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from eunnote_gpu.collector import command_label, is_filler_command, redact_arguments
from eunnote_gpu.common import discover_nodes, normalize_report_url
from eunnote_gpu.ggpu import duration_since
from eunnote_gpu.track import apply_idle_tracking


class CollectorTests(unittest.TestCase):
    def test_filler_identification(self):
        self.assertTrue(is_filler_command(["python3", "/tmp/eunnote_gpu_filler_abc.py", "--gpu-index", "0"]))
        self.assertTrue(is_filler_command(["python", "-m", "eunnote_gpu.filler_worker"]))
        self.assertFalse(is_filler_command(["python", "train.py", "--gpu-index", "0"]))

    def test_sensitive_arguments_are_redacted(self):
        arguments = redact_arguments(["python", "train.py", "--token", "secret", "--api-key=value", "--epochs", "3"])
        self.assertEqual(arguments, ["python", "train.py", "--token", "<redacted>", "--api-key=<redacted>", "--epochs", "3"])
        self.assertNotIn("secret", command_label(arguments, "python"))


class IdleTrackingTests(unittest.TestCase):
    def test_idle_start_persists_until_real_work_appears(self):
        state = {}
        nodes = [{"name": "node-a", "gpus": [{"index": 0, "uuid": "GPU-a", "inUse": False}]}]
        apply_idle_tracking(nodes, state, "2026-01-01T00:00:00Z")
        self.assertEqual(nodes[0]["gpus"][0]["idleSince"], "2026-01-01T00:00:00Z")
        apply_idle_tracking(nodes, state, "2026-01-01T01:00:00Z")
        self.assertEqual(nodes[0]["gpus"][0]["idleSince"], "2026-01-01T00:00:00Z")
        nodes[0]["gpus"][0]["inUse"] = True
        apply_idle_tracking(nodes, state, "2026-01-01T02:00:00Z")
        self.assertIsNone(nodes[0]["gpus"][0]["idleSince"])
        nodes[0]["gpus"][0]["inUse"] = False
        apply_idle_tracking(nodes, state, "2026-01-01T03:00:00Z")
        self.assertEqual(nodes[0]["gpus"][0]["idleSince"], "2026-01-01T03:00:00Z")

    def test_duration_format(self):
        with patch("eunnote_gpu.ggpu.datetime") as mocked:
            mocked.now.return_value = datetime(2026, 1, 1, 2, 5, tzinfo=timezone.utc)
            mocked.fromisoformat.side_effect = datetime.fromisoformat
            self.assertEqual(duration_since("2026-01-01T00:00:00Z"), "2h05m")


class DiscoveryTests(unittest.TestCase):
    def test_explicit_hosts_are_deduplicated(self):
        with patch.dict(os.environ, {"EUNNOTE_GPU_HOSTS": "node-a,node-b,node-a"}, clear=True):
            self.assertEqual(discover_nodes(), (["node-a", "node-b"], "EUNNOTE_GPU_HOSTS"))

    def test_report_url_normalization(self):
        self.assertEqual(normalize_report_url("http://host:6357"), "http://host:6357/notion/api/gpu/report")
        self.assertEqual(normalize_report_url("http://host:6357/notion/"), "http://host:6357/notion/api/gpu/report")


if __name__ == "__main__":
    unittest.main()
