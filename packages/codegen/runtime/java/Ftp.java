package support;

import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.SftpException;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Vector;
import org.apache.commons.net.ftp.FTP;
import org.apache.commons.net.ftp.FTPClient;
import org.apache.commons.net.ftp.FTPFile;
import org.apache.commons.net.ftp.FTPSClient;

/**
 * FTP, FTPS and SFTP for tests exported by StepForge (by Md Zarin Tasnim): upload (a local file, or `content` as text),
 * download (its text can be checked), list a folder, delete, exists. Commons Net for FTP and FTPS, JSch for SFTP.
 */
public final class Ftp {
  private Ftp() {}

  private static String s(Map<String, Object> o, String key, String fallback) {
    Object v = o.get(key);
    return v == null || "".equals(v) ? fallback : Checks.text(v);
  }

  /** What a step can check: content, size, path (download); count, names, entries (list); exists. */
  public static Map<String, Object> run(Map<String, Object> o) throws Exception {
    String action = s(o, "action", "list");
    String remote = s(o, "remotePath", action.equals("list") ? "." : "");
    if (remote.isEmpty()) throw new IllegalArgumentException("ftp " + action + " needs a remotePath");
    return "sftp".equals(s(o, "protocol", "ftp")) ? sftp(o, action, remote) : ftp(o, action, remote);
  }

  private static byte[] source(Map<String, Object> o) throws Exception {
    String content = s(o, "content", null);
    if (content != null) return content.getBytes(StandardCharsets.UTF_8);
    String local = s(o, "localPath", null);
    if (local == null) throw new IllegalArgumentException("ftp upload needs localPath or content");
    return Files.readAllBytes(Path.of(local));
  }

  private static Map<String, Object> downloaded(Map<String, Object> o, String remote, byte[] bytes) throws Exception {
    String local = s(o, "localPath", null);
    Path to = local != null ? Path.of(local) : Files.createTempDirectory("ftp-").resolve(Path.of(remote).getFileName().toString());
    Files.write(to, bytes);
    return J.map("path", to.toString(), "size", bytes.length, "content", bytes.length <= 5_000_000 ? new String(bytes, StandardCharsets.UTF_8) : "");
  }

  private static Map<String, Object> listed(List<Map<String, Object>> entries) {
    return J.map("entries", entries, "count", entries.size(), "names", entries.stream().map(e -> e.get("name")).toList());
  }

  private static Map<String, Object> ftp(Map<String, Object> o, String action, String remote) throws Exception {
    boolean secure = "ftps".equals(s(o, "protocol", "ftp"));
    FTPClient c = secure ? new FTPSClient() : new FTPClient();
    int timeout = o.get("timeoutMs") == null ? 15_000 : J.toInt(o.get("timeoutMs"));
    c.setConnectTimeout(timeout);
    c.setDefaultTimeout(timeout);
    c.connect(s(o, "host", ""), J.toInt(s(o, "port", "21")));
    try {
      if (!c.login(s(o, "username", "anonymous"), s(o, "password", ""))) throw new IllegalStateException("FTP login failed: " + c.getReplyString().trim());
      if (c instanceof FTPSClient ftps) {
        ftps.execPBSZ(0);
        ftps.execPROT("P");
      }
      c.enterLocalPassiveMode();
      c.setFileType(FTP.BINARY_FILE_TYPE);
      switch (action) {
        case "upload": {
          byte[] bytes = source(o);
          try (InputStream in = new ByteArrayInputStream(bytes)) {
            if (!c.storeFile(remote, in)) throw new IllegalStateException("Upload failed: " + c.getReplyString().trim());
          }
          return J.map("path", remote, "size", bytes.length);
        }
        case "download": {
          var out = new java.io.ByteArrayOutputStream();
          if (!c.retrieveFile(remote, out)) throw new AssertionError("Download failed: " + c.getReplyString().trim());
          return downloaded(o, remote, out.toByteArray());
        }
        case "list": {
          List<Map<String, Object>> entries = new ArrayList<>();
          for (FTPFile f : c.listFiles(remote))
            entries.add(J.map("name", f.getName(), "size", f.getSize(), "type", f.isDirectory() ? "directory" : f.isFile() ? "file" : "other"));
          return listed(entries);
        }
        case "delete":
          if (!c.deleteFile(remote)) throw new AssertionError("Delete failed: " + c.getReplyString().trim());
          return J.map();
        default: {
          // Listed in its parent folder; "dir/" is "dir", and the root always exists.
          String path = remote.replaceAll("/+$", "");
          if (path.isEmpty() || path.equals(".")) return J.map("exists", true);
          int slash = path.lastIndexOf('/');
          String dir = slash < 0 ? "." : slash == 0 ? "/" : path.substring(0, slash);
          String name = path.substring(slash + 1);
          boolean exists = false;
          for (FTPFile f : c.listFiles(dir)) exists |= name.equals(f.getName());
          return J.map("exists", exists);
        }
      }
    } finally {
      try {
        c.logout();
      } catch (Exception ignored) {
        // closing anyway
      }
      c.disconnect();
    }
  }

  private static Map<String, Object> sftp(Map<String, Object> o, String action, String remote) throws Exception {
    JSch jsch = new JSch();
    String key = s(o, "privateKey", null);
    if (key != null) jsch.addIdentity(key);
    Session session = jsch.getSession(s(o, "username", "anonymous"), s(o, "host", ""), J.toInt(s(o, "port", "22")));
    if (key == null) session.setPassword(s(o, "password", ""));
    // Test servers are rarely in known_hosts.
    session.setConfig("StrictHostKeyChecking", "no");
    session.connect(o.get("timeoutMs") == null ? 15_000 : J.toInt(o.get("timeoutMs")));
    ChannelSftp ch = (ChannelSftp) session.openChannel("sftp");
    ch.connect();
    try {
      switch (action) {
        case "upload": {
          byte[] bytes = source(o);
          ch.put(new ByteArrayInputStream(bytes), remote);
          return J.map("path", remote, "size", bytes.length);
        }
        case "download": {
          var out = new java.io.ByteArrayOutputStream();
          ch.get(remote, (OutputStream) out);
          return downloaded(o, remote, out.toByteArray());
        }
        case "list": {
          List<Map<String, Object>> entries = new ArrayList<>();
          for (Object x : (Vector<?>) ch.ls(remote)) {
            ChannelSftp.LsEntry e = (ChannelSftp.LsEntry) x;
            if (e.getFilename().equals(".") || e.getFilename().equals("..")) continue;
            entries.add(J.map("name", e.getFilename(), "size", e.getAttrs().getSize(), "type", e.getAttrs().isDir() ? "directory" : e.getAttrs().isReg() ? "file" : "other"));
          }
          return listed(entries);
        }
        case "delete":
          ch.rm(remote);
          return J.map();
        default: {
          String path = remote.replaceAll("/+$", "");
          if (path.isEmpty() || path.equals(".")) return J.map("exists", true);
          try {
            ch.stat(path);
            return J.map("exists", true);
          } catch (SftpException e) {
            if (e.id == ChannelSftp.SSH_FX_NO_SUCH_FILE) return J.map("exists", false);
            throw e;
          }
        }
      }
    } finally {
      ch.disconnect();
      session.disconnect();
    }
  }
}
