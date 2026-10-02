using System;
using System.Collections.Generic;
public static class FrameRevealTests {
    static int passed;
    static void Reject(Action action) { try { action(); } catch { passed++; return; } throw new Exception("Unsafe argument was accepted"); }
    public static int Main() {
        try {
            string token = new String('a', 64);
            if (FrameReveal.ParseTicket("frame-local-reveal://reveal/" + token) != token) throw new Exception("Valid ticket rejected"); passed++;
            foreach (string value in new [] { "https://example.com", "frame-local-reveal://reveal/../a", "frame-local-reveal://other/" + token, "frame-local-reveal://reveal/" + token + "?path=C:/secret", "frame-local-reveal://reveal/" + token + "#x", "frame-local-reveal://user@reveal/" + token }) Reject(() => FrameReveal.ParseTicket(value));
            foreach (string value in new [] { @"\\server\share\a.mp4", "https://example.com/a.mp4", "relative.mp4", "C:/a.mp4:stream" }) Reject(() => FrameReveal.LocalFile(value));
            if (!FrameReveal.LocalFile("C:/中文 folder/clip.mp4").EndsWith("clip.mp4")) throw new Exception("Unicode path rejected"); passed++;
            Reject(() => FrameReveal.ConfigPort(new Dictionary<string, object>{{"port", 65536}}));
            Console.WriteLine(passed + " native validation checks passed."); return 0;
        } catch (Exception e) { Console.Error.WriteLine(e); return 1; }
    }
}
