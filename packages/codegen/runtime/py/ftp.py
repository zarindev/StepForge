"""FTP, FTPS and SFTP for tests exported by StepForge (by Md Zarin Tasnim), with ftplib and paramiko (SFTP)."""
import ftplib
import io
import os
import posixpath
import ssl
import tempfile


class _Ftp:
    def __init__(self, o, timeout):
        secure = o.get("protocol") == "ftps"
        if secure:
            # Test servers often use self-signed certificates.
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            self.c = ftplib.FTP_TLS(context=context, timeout=timeout)
        else:
            self.c = ftplib.FTP(timeout=timeout)
        self.c.connect(o["host"], int(o.get("port") or 21))
        self.c.login(o.get("username") or "anonymous", o.get("password") or "")
        if secure:
            self.c.prot_p()

    def upload(self, data, to):
        self.c.storbinary(f"STOR {to}", io.BytesIO(data))

    def download(self, src, to):
        with open(to, "wb") as f:
            self.c.retrbinary(f"RETR {src}", f.write)

    def list(self, folder):
        try:
            return [
                {"name": name, "size": int(facts.get("size", 0)), "type": "directory" if facts.get("type") == "dir" else "file"}
                for name, facts in self.c.mlsd(folder)
                if facts.get("type") not in ("cdir", "pdir")
            ]
        except ftplib.error_perm:
            return [{"name": posixpath.basename(n), "size": 0, "type": "other"} for n in self.c.nlst(folder)]

    def remove(self, path):
        self.c.delete(path)

    def exists(self, path):
        # Listed in its parent folder; a missing parent means it does not exist.
        folder = posixpath.dirname(path) or "."
        try:
            return posixpath.basename(path) in [posixpath.basename(n) for n in self.c.nlst(folder)]
        except ftplib.error_perm:
            return False

    def close(self):
        try:
            self.c.quit()
        except Exception:  # noqa: BLE001 - already closed by the server
            self.c.close()


class _Sftp:
    def __init__(self, o, timeout):
        import paramiko

        self.t = paramiko.Transport((o["host"], int(o.get("port") or 22)))
        self.t.banner_timeout = timeout
        key = paramiko.RSAKey.from_private_key_file(o["privateKey"]) if o.get("privateKey") else None
        self.t.connect(username=o.get("username") or "anonymous", password=None if key else (o.get("password") or ""), pkey=key)
        self.c = paramiko.SFTPClient.from_transport(self.t)

    def upload(self, data, to):
        self.c.putfo(io.BytesIO(data), to)

    def download(self, src, to):
        self.c.get(src, to)

    def list(self, folder):
        return [
            {"name": a.filename, "size": a.st_size or 0, "type": "directory" if (a.st_mode or 0) & 0o040000 else "file"}
            for a in self.c.listdir_attr(folder)
        ]

    def remove(self, path):
        self.c.remove(path)

    def exists(self, path):
        try:
            self.c.stat(path)
            return True
        except FileNotFoundError:
            return False

    def close(self):
        self.c.close()
        self.t.close()


def ftp(o):
    """upload (a local file, or content as text), download (its text can be checked), list, delete, exists."""
    action = o.get("action", "list")
    remote_path = o.get("remotePath") or ("." if action == "list" else "")
    if not remote_path:
        raise AssertionError(f"ftp {action} needs a remotePath")
    timeout = (o.get("timeoutMs") or 15000) / 1000
    remote = _Sftp(o, timeout) if o.get("protocol") == "sftp" else _Ftp(o, timeout)
    try:
        if action == "upload":
            if o.get("content") not in (None, ""):
                data = str(o["content"]).encode()
            elif o.get("localPath"):
                with open(o["localPath"], "rb") as f:
                    data = f.read()
            else:
                raise AssertionError("ftp upload needs localPath or content")
            remote.upload(data, remote_path)
            return {"path": remote_path, "size": len(data)}
        if action == "download":
            to = o.get("localPath") or os.path.join(tempfile.mkdtemp(prefix="ftp-"), posixpath.basename(remote_path))
            remote.download(remote_path, to)
            size = os.path.getsize(to)
            with open(to, encoding="utf-8", errors="replace") as f:
                content = f.read() if size <= 5_000_000 else ""
            return {"path": to, "size": size, "content": content}
        if action == "list":
            entries = remote.list(remote_path)
            return {"entries": entries, "count": len(entries), "names": [e["name"] for e in entries]}
        if action == "delete":
            remote.remove(remote_path)
            return {}
        # "dir/" is "dir"; the root (and the login folder) always exist.
        path = remote_path.rstrip("/")
        return {"exists": True if path in ("", ".") else remote.exists(path)}
    finally:
        remote.close()
