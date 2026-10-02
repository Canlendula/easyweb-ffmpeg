using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

[assembly: AssemblyTitle("Frame 文件夹助手")]
[assembly: AssemblyProduct("Frame Local FFmpeg")]
[assembly: AssemblyVersion("1.0.0.0")]

public static class FrameReveal {
    public const string Scheme = "frame-local-reveal";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 65536 };
    [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved, uint flags);
    [DllImport("ole32.dll")] static extern void CoUninitialize();
    [DllImport("ole32.dll")] static extern int CoAllowSetForegroundWindow(IntPtr unknown, IntPtr reserved);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHParseDisplayName(string name, IntPtr bind, out IntPtr pidl, uint attributes, out uint result);
    [DllImport("shell32.dll")] static extern int SHOpenFolderAndSelectItems(IntPtr pidl, uint count, IntPtr items, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int show);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(uint process);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

    public static string ParseTicket(string argument) {
        if (argument == null || !Regex.IsMatch(argument, "^frame-local-reveal://reveal/[a-f0-9]{64}$", RegexOptions.CultureInvariant))
            throw new ArgumentException("Invalid Frame reveal link.");
        return argument.Substring(argument.LastIndexOf('/') + 1);
    }
    public static string LocalFile(string file) {
        if (String.IsNullOrEmpty(file) || !Regex.IsMatch(file, @"^[a-zA-Z]:[\\/]")) throw new ArgumentException("A local disk file is required.");
        if (file.Substring(2).Contains(":")) throw new ArgumentException("Alternate data streams are not supported.");
        return Path.GetFullPath(file);
    }
    public static int ConfigPort(Dictionary<string, object> config) {
        int port = Convert.ToInt32(config["port"]);
        if (port < 1 || port > 65535) throw new ArgumentException("Invalid local port.");
        return port;
    }
    private static Dictionary<string, object> Request(string route, object payload, int port, string secret) {
        // The URI cannot choose a host, port, path or executable. These come from the local installation.
        var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/native-reveal/" + route);
        request.Proxy = null; request.AllowAutoRedirect = false; request.Timeout = 5000; request.ReadWriteTimeout = 5000;
        request.Method = "POST"; request.ContentType = "application/json; charset=utf-8";
        request.Headers["X-Frame-Bridge"] = secret;
        byte[] bytes = Encoding.UTF8.GetBytes(Json.Serialize(payload)); request.ContentLength = bytes.Length;
        using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
        using (var response = request.GetResponse())
        using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) return Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
    }
    private static dynamic FindWindow(dynamic shell, string folder) {
        foreach (dynamic candidate in shell.Windows()) {
            try {
                string location = Convert.ToString(candidate.Document.Folder.Self.Path);
                if (String.Equals(location.TrimEnd('\\'), folder.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) return candidate;
            } catch { }
        }
        return null;
    }
    private static void OpenPath(string file) {
        IntPtr pidl = IntPtr.Zero;
        try {
            uint attributes;
            Marshal.ThrowExceptionForHR(SHParseDisplayName(file, IntPtr.Zero, out pidl, 0, out attributes));
            Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(pidl, 0, IntPtr.Zero, 0));
        } finally { if (pidl != IntPtr.Zero) Marshal.FreeCoTaskMem(pidl); }
    }
    private static Dictionary<string, object> Reveal(string file) {
        string folder = Path.GetDirectoryName(file);
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
        IntPtr unknown = Marshal.GetIUnknownForObject(shell);
        int transferred;
        try { transferred = CoAllowSetForegroundWindow(unknown, IntPtr.Zero); }
        finally { Marshal.Release(unknown); }
        dynamic window = FindWindow(shell, folder);
        bool reused = window != null;
        if (window == null) {
            OpenPath(file);
            for (int attempt = 0; attempt < 50; attempt++) {
                window = FindWindow(shell, folder);
                if (window != null) break;
                Thread.Sleep(100);
            }
        }
        if (window == null) throw new InvalidOperationException("无法找到目标文件夹窗口");
        IntPtr handle = new IntPtr(Convert.ToInt64(window.HWND));
        uint explorerProcess; GetWindowThreadProcessId(handle, out explorerProcess);
        bool allowed = AllowSetForegroundWindow(explorerProcess);
        window.Visible = true;
        dynamic item = window.Document.Folder.ParseName(Path.GetFileName(file));
        if (item != null) window.Document.SelectItem(item, 29);
        ShowWindow(handle, IsIconic(handle) ? 9 : 5);
        if (!SetWindowPos(handle, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        BringWindowToTop(handle); SetForegroundWindow(handle);
        // Activation can be asynchronous across input queues. Observe, without simulating user input.
        for (int attempt = 0; attempt < 15 && GetForegroundWindow() != handle; attempt++) Thread.Sleep(50);
        string locationNow = Convert.ToString(window.Document.Folder.Self.Path);
        bool selected = false;
        foreach (dynamic entry in window.Document.SelectedItems()) {
            if (String.Equals(Convert.ToString(entry.Path), file, StringComparison.OrdinalIgnoreCase)) selected = true;
        }
        return new Dictionary<string, object> {
            {"folderMatched", String.Equals(locationNow.TrimEnd('\\'), folder.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)},
            {"visible", IsWindowVisible(handle)}, {"minimized", IsIconic(handle)}, {"foreground", GetForegroundWindow() == handle},
            {"selected", selected}, {"reused", reused}, {"windowHandle", handle.ToInt64()},
            {"foregroundGrant", allowed}, {"comForegroundGrant", transferred == 0}
        };
    }
    private static void SaveEvidence(string baseDir, Dictionary<string, object> result) {
        try {
            var record = new Dictionary<string, object>(result); record["checkedAt"] = DateTime.UtcNow.ToString("o");
            File.WriteAllText(Path.Combine(baseDir, "last-result.json"), Json.Serialize(record), new UTF8Encoding(false));
        } catch { }
    }
    [STAThread]
    public static int Main(string[] args) {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string ticket;
        // Record launch diagnostics without the URI, ticket or shared secret.
        try { File.WriteAllText(Path.Combine(baseDir, "last-launch.json"), Json.Serialize(new { startedAt = DateTime.UtcNow.ToString("o"), argumentCount = args.Length }), new UTF8Encoding(false)); } catch { }
        try { if (args.Length != 1) throw new ArgumentException("Expected one protocol URI."); ticket = ParseTicket(args[0]); }
        catch (Exception error) { SaveEvidence(baseDir, new Dictionary<string, object> { { "error", error.Message }, { "stage", "arguments" } }); return 1; }
        string secret = "";
        int port = 0, initialized = CoInitializeEx(IntPtr.Zero, 2);
        bool claimed = false;
        using (var watchdog = new Timer(_ => Environment.Exit(2), null, 20000, Timeout.Infinite)) {
            try {
                var config = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(baseDir, "config.json"), Encoding.UTF8));
                port = ConfigPort(config); secret = Convert.ToString(config["secret"]);
                if (!Regex.IsMatch(secret, "^[a-f0-9]{64}$")) throw new ArgumentException("Invalid local configuration.");
                var payload = Request(ticket + "/claim", new { }, port, secret); claimed = true;
                string file = LocalFile(Convert.ToString(payload["path"]));
                if (!File.Exists(file)) throw new FileNotFoundException("结果文件不存在");
                var result = Reveal(file);
                Request(ticket + "/result", result, port, secret); SaveEvidence(baseDir, result);
                return result["visible"].Equals(true) ? 0 : 1;
            } catch (Exception error) {
                var result = new Dictionary<string, object> { { "error", error.Message } };
                if (claimed) { try { Request(ticket + "/result", result, port, secret); } catch { } }
                SaveEvidence(baseDir, result); return 1;
            } finally { if (initialized >= 0) CoUninitialize(); }
        }
    }
}
