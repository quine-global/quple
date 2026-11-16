#!/usr/bin/env python3
"""Writes Quple's AltStore source (source.json) for one build, to stdout.

The format: https://faq.altstore.io/developers/make-a-source. The app's
privacy keys are read from the .ipa's Info.plist, since AltStore checks
that a source declares the permissions the app asks for.
"""

import argparse
import datetime
import json
import os
import plistlib
import zipfile

p = argparse.ArgumentParser()
p.add_argument("--ipa", required=True)
p.add_argument("--version", required=True)
p.add_argument("--build", required=True)
p.add_argument("--public", required=True, help="URL the release's files are downloaded from")
p.add_argument("--commit", required=True)
a = p.parse_args()

with zipfile.ZipFile(a.ipa) as z:
    plist = next(n for n in z.namelist() if n.count("/") == 2 and n.endswith(".app/Info.plist"))
    info = plistlib.loads(z.read(plist))

privacy = {k: v for k, v in info.items() if k.startswith("NS") and k.endswith("UsageDescription")}
public = a.public.rstrip("/")
description = (
    "Call people by their Quine username, on Jitsi Meet. Calls ring on "
    "the iPhone's own call screen while Quple is open."
)

source = {
    "name": "Quple",
    "identifier": "com.quineglobal.quple.altstore",
    "subtitle": "Quine's calling app",
    "description": description,
    "iconURL": f"{public}/icon.png",
    "website": "https://git.quineglobal.com/quine-global/quple",
    "sourceURL": f"{public}/source.json",
    "tintColor": "#3A78F2",
    "apps": [
        {
            "name": "Quple",
            "bundleIdentifier": info["CFBundleIdentifier"],
            "developerName": "Quine",
            "subtitle": "Call people by username",
            "localizedDescription": description,
            "iconURL": f"{public}/icon.png",
            "tintColor": "#3A78F2",
            "category": "social",
            "screenshots": [],
            "versions": [
                {
                    "version": a.version,
                    "buildVersion": a.build,
                    "date": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                    "localizedDescription": f"Build {a.build} (commit {a.commit}).",
                    "downloadURL": f"{public}/Quple-{a.build}.ipa",
                    "size": os.path.getsize(a.ipa),
                    "minOSVersion": info.get("MinimumOSVersion", "15.1"),
                }
            ],
            "appPermissions": {"entitlements": [], "privacy": privacy},
        }
    ],
    "news": [],
}

json.dump(source, __import__("sys").stdout, indent=2)
print()
