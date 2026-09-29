import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "installer", Path(__file__).parents[1] / "scripts" / "install-box-mount.py"
)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / "bundle.tgz"
        self.bin = self.root / "bin"

    def bundle(self, entries):
        with tarfile.open(self.archive, "w:gz") as bundle:
            for name, content, mode in entries:
                member = tarfile.TarInfo(name)
                member.size = len(content)
                member.mode = mode
                bundle.addfile(member, io.BytesIO(content))

    def test_installs_named_binary_with_engine_alias(self):
        binary = b"\x7fELF\x00\xfffake-binary"
        self.bundle([
            ("release/box-mount", binary, 0o755),
            ("release/README.md", b"docs", 0o644),
            ("release/install.sh", b"installer", 0o755),
        ])
        installer.install(str(self.archive), str(self.bin))
        self.assertEqual((self.bin / "agent-mount").read_bytes(), binary)
        self.assertTrue((self.bin / "box-mount").is_symlink())
        self.assertEqual((self.bin / "box-mount").read_bytes(), binary)
        self.assertEqual((self.bin / "agent-mount").stat().st_mode & 0o777, 0o755)

    def test_archive_paths_are_never_extracted(self):
        self.bundle([("../../outside", b"binary", 0o755)])
        installer.install(str(self.archive), str(self.bin))
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ["bin", "bundle.tgz"])
        self.assertEqual((self.bin / "box-mount").read_bytes(), b"binary")

    def test_link_only_archive_is_rejected(self):
        with tarfile.open(self.archive, "w:gz") as bundle:
            member = tarfile.TarInfo("box-mount")
            member.type = tarfile.SYMTYPE
            member.linkname = "/etc/passwd"
            bundle.addfile(member)
        with self.assertRaisesRegex(RuntimeError, "Expected one"):
            installer.install(str(self.archive), str(self.bin))

    def test_ambiguous_executables_are_rejected(self):
        self.bundle([("one", b"1", 0o755), ("two", b"2", 0o755)])
        with self.assertRaisesRegex(RuntimeError, "Expected one"):
            installer.install(str(self.archive), str(self.bin))

    def test_agent_mount_name_and_reinstallation(self):
        self.bundle([("release/agent-mount", b"binary", 0o755)])
        installer.install(str(self.archive), str(self.bin))
        installer.install(str(self.archive), str(self.bin))
        self.assertEqual((self.bin / "box-mount").read_bytes(), b"binary")


if __name__ == "__main__":
    unittest.main()
