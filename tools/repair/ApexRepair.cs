// ApexRepair.cs — the one-double-click recovery tool for broken installs.
// -----------------------------------------------------------------------------
// Field reality (2026-08-20, tester with Norton): an antivirus quarantine can
// leave a machine where no Apex installer will run — half-deleted install
// folders, stale uninstall registry entries the installer trips over, ghost
// processes, a poisoned updater cache. Walking a tester through PowerShell
// lines over Discord is not support. This compiles to a single signed exe
// (scripts/build-repair-tool.js) that cleans all of it and reports what it did.
//
// It NEVER touches user data: settings, lap history and downloaded voices in
// %APPDATA%\apex-overlay-system stay exactly where they are.
//
// Compiled with the .NET Framework 4.x csc.exe that ships with Windows —
// no SDK, no runtime to install, runs on any Windows 10/11 box as-is.

using System;
using System.Diagnostics;
using System.IO;
using Microsoft.Win32;

static class ApexRepair
{
    const string ProductName = "Apex Overlay System";
    const string UninstallGuid = "50aae0a8-8efa-5004-9650-1999f158e8f8";

    static int _fixed;
    static int _failed;

    static void Main()
    {
        Console.Title = ProductName + " Repair Tool";
        Console.WriteLine("=== " + ProductName + " Repair Tool ===");
        Console.WriteLine();
        Console.WriteLine("This removes the leftovers of a broken install so a fresh installer");
        Console.WriteLine("can run: stuck processes, old install folders, stale registry entries");
        Console.WriteLine("and the updater's download cache.");
        Console.WriteLine();
        Console.WriteLine("Your settings, lap history and voices are NOT touched.");
        Console.WriteLine();
        Console.Write("Press Y to clean up, or any other key to quit: ");
        var key = Console.ReadKey();
        Console.WriteLine();
        Console.WriteLine();
        if (key.Key != ConsoleKey.Y) return;

        KillProcesses();
        RemoveUninstallEntries();
        RemoveDir(Path.Combine(LocalAppData(), "Programs", ProductName), "old install folder");
        RemoveDir(Path.Combine(LocalAppData(), "apex-overlay-system-updater"), "updater download cache");
        ReportDiskSpace();

        Console.WriteLine();
        Console.WriteLine("Done - " + _fixed + " thing(s) cleaned, " + _failed + " problem(s).");
        Console.WriteLine();
        Console.WriteLine("Next step: download the NEWEST installer fresh from the site and run it.");
        Console.WriteLine("If your antivirus objects to the download, choose to keep/restore the");
        Console.WriteLine("file - the installer and everything in it is signed by The Lilybank");
        Console.WriteLine("Agency Ltd.");
        Console.WriteLine();
        Console.Write("Press any key to close. ");
        Console.ReadKey();
    }

    static string LocalAppData()
    {
        return Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    }

    static void KillProcesses()
    {
        var any = false;
        foreach (var p in Process.GetProcessesByName(ProductName))
        {
            any = true;
            try
            {
                p.Kill();
                p.WaitForExit(5000);
                Ok("closed a running copy of the app (pid " + p.Id + ")");
            }
            catch (Exception e)
            {
                Bad("could not close pid " + p.Id + ": " + e.Message);
            }
        }
        if (!any) Console.WriteLine("  -     no Apex processes running (good)");
    }

    static void RemoveUninstallEntries()
    {
        // Per-user installs register under HKCU; ancient or per-machine ones
        // could sit in HKLM or its 32-bit view. Check all of them, match by
        // our GUID or by display name, delete what matches.
        var found = false;
        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        {
            foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                try
                {
                    using (var root = RegistryKey.OpenBaseKey(hive, view))
                    using (var uninstall = root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall", true))
                    {
                        if (uninstall == null) continue;
                        foreach (var name in uninstall.GetSubKeyNames())
                        {
                            string display = null;
                            using (var sub = uninstall.OpenSubKey(name))
                            {
                                if (sub != null) display = sub.GetValue("DisplayName") as string;
                            }
                            var ours = name.StartsWith(UninstallGuid, StringComparison.OrdinalIgnoreCase)
                                || (display != null && display.StartsWith(ProductName, StringComparison.OrdinalIgnoreCase));
                            if (!ours) continue;
                            found = true;
                            try
                            {
                                uninstall.DeleteSubKeyTree(name);
                                Ok("removed stale uninstall entry (" + hive + @"\" + name + ")");
                            }
                            catch (Exception e)
                            {
                                Bad("could not remove uninstall entry " + name + ": " + e.Message);
                            }
                        }
                    }
                }
                catch
                {
                    // No access to this hive/view (not elevated) - per-user
                    // installs never need it, so silence is correct here.
                }
            }
        }
        if (!found) Console.WriteLine("  -     no stale uninstall entries (good)");
    }

    static void RemoveDir(string dir, string label)
    {
        if (!Directory.Exists(dir))
        {
            Console.WriteLine("  -     no " + label + " to remove (good)");
            return;
        }
        try
        {
            Directory.Delete(dir, true);
            Ok("removed " + label + " (" + dir + ")");
        }
        catch (Exception e)
        {
            Bad("could not remove " + label + ": " + e.Message
                + " - if this keeps happening, restart the PC and run this tool again");
        }
    }

    static void ReportDiskSpace()
    {
        try
        {
            var drive = new DriveInfo(Path.GetPathRoot(LocalAppData()));
            var freeGb = drive.AvailableFreeSpace / 1024.0 / 1024.0 / 1024.0;
            if (freeGb < 1.5)
                Bad(string.Format("only {0:F1} GB free on {1} - the installer needs about 1 GB free", freeGb, drive.Name));
            else
                Console.WriteLine(string.Format("  -     {0:F1} GB free on {1} (plenty)", freeGb, drive.Name));
        }
        catch
        {
        }
    }

    static void Ok(string what)
    {
        _fixed++;
        Console.WriteLine("  FIXED  " + what);
    }

    static void Bad(string what)
    {
        _failed++;
        Console.WriteLine("  !!     " + what);
    }
}
