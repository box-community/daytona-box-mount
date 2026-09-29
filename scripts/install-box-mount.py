"""Install the supplied preview binary without extracting archive paths or links."""

import shutil
import sys
import tarfile
from pathlib import Path


def install(archive: str, bin_dir: str) -> None:
    with tarfile.open(archive, "r:gz") as bundle:
        files = [member for member in bundle.getmembers() if member.isfile()]
        named = [
            member for member in files
            if Path(member.name).name in ("box-mount", "agent-mount")
        ]
        executables = [member for member in files if member.mode & 0o111]
        if len(named) == 1:
            source = named[0]
        elif len(executables) == 1:
            source = executables[0]
        elif len(files) == 1:
            source = files[0]
        else:
            raise RuntimeError(
                f"Expected one Box Mount executable; found {len(files)} files"
            )

        destination = Path(bin_dir)
        destination.mkdir(parents=True, exist_ok=True)
        target = destination / "agent-mount"
        with bundle.extractfile(source) as content, target.open("wb") as output:
            shutil.copyfileobj(content, output)
        target.chmod(0o755)
        # Preview builds locate their sync engine by the agent-mount name.
        link = destination / "box-mount"
        link.unlink(missing_ok=True)
        link.symlink_to("agent-mount")


if __name__ == "__main__":
    install(sys.argv[1], sys.argv[2])
